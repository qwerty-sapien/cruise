import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assessProvisionTrust,
  acquireExternalCandidate,
  authorizeProvisionEffect,
  capabilityRequestRepositoryRoot,
  createAuthJob,
  createCapabilityRequest,
  createCapabilityFallbackApproval,
  createHostSandboxAttestation,
  createProvisionAuthVerificationBroker,
  createProvisionIsolationBroker,
  createProvisionHostingApiBroker,
  createProvisionInstallExecutionBroker,
  createProvisionInstallerBroker,
  createProvisionNeedAssessmentBroker,
  createProvisionRollbackBroker,
  createProvisionRun as createProvisionRunRecord,
  createProvisionSmokeVerificationBroker,
  evaluateExternalCandidate,
  loadProvisionExclusionSnapshot,
  parseProvisionYaml,
  ProvisionCycleError,
  ProvisionScheduler,
  ProvisionStateStore,
  RESOLUTION_ORDER,
  runExternalBehaviorEvaluation,
  runPrivateProvisionSelection,
  runInstructionSandboxAnalysis,
  createTrustedInstallerAttestation,
  sanitizeProvisionRecord,
  stringifyProvisionYaml,
} from '../scripts/lib/provision.mjs';

const fixedNow = () => new Date('2026-07-13T00:00:00.000Z');
const REVIEWED_COMMIT = 'a'.repeat(40);
const ORIGIN_SHA256 = 'c'.repeat(64);
const EXCLUSION_SNAPSHOT = await loadProvisionExclusionSnapshot({ root: process.cwd() });

function stableSha256(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry === null || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function isolationProbeObservation({ kind, profile, directActivationChallenge = null }) {
  const observation = {
    profile,
    isolation_id: `scheduler-test-${kind}`,
    observed_at: '2026-07-13T00:00:00.000Z',
    enforcement_kind: 'disposable-test-isolate',
    probe_sha256: createHash('sha256').update(`scheduler-${kind}`).digest('hex'),
  };
  if (directActivationChallenge) {
    const evidencePayload = {
      schema_version: 1,
      direct_external_activation_allowed: true,
      challenge_nonce: directActivationChallenge.nonce,
      context_sha256: directActivationChallenge.context_sha256,
      observed_at: observation.observed_at,
      isolation_id: observation.isolation_id,
      enforcement_kind: observation.enforcement_kind,
      profile_sha256: stableSha256(profile),
      technical_probe_sha256: observation.probe_sha256,
    };
    observation.direct_activation = {
      allowed: true,
      challenge_nonce: directActivationChallenge.nonce,
      context_sha256: directActivationChallenge.context_sha256,
      observed_at: observation.observed_at,
      evidence_sha256: stableSha256(evidencePayload),
    };
  }
  return observation;
}

function stableTestDigest(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry === null || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function hostingApiBroker(api) {
  return createProvisionHostingApiBroker({
    issuer: 'trusted-cruise-hosting-api-broker',
    providerSource: 'hosting-api',
    repositoryHosts: ['example.invalid', 'github.example'],
    ...api,
  });
}

const INSTALLER_BROKER = createProvisionInstallerBroker({
  issuer: 'trusted-cruise-installer-broker',
  inspectExecutable: ({ command_file: commandFile }) => ({
    resolved_path: `/usr/local/bin/${commandFile}`,
    file_sha256: createHash('sha256').update(`installer:${commandFile}`).digest('hex'),
    observed_at: '2026-07-13T00:00:00.000Z',
    regular_file: true,
    symlink: false,
    executable: true,
  }),
});
const INSTALLER_ATTESTATION = createTrustedInstallerAttestation({
  commandFile: 'npm',
  broker: INSTALLER_BROKER,
});

function createProvisionRun(options) {
  return createProvisionRunRecord({
    requestId: 'CAPREQ-001',
    capabilityRequest: SCHEDULER_REQUEST,
    ...options,
  });
}

const instructionSandbox = {
  target_repository_access: false,
  user_home_access: false,
  credentials_available: false,
  environment_secrets_available: false,
  write_scope: 'dedicated-temporary-result-only',
  external_effect_tools: false,
  network_after_acquisition: false,
  package_installation: false,
  candidate_shell_execution: false,
  candidate_activated: false,
  structured_output_only: true,
};

const executionSandbox = {
  disposable: true,
  target_repository_secrets: false,
  ssh_agent: false,
  cloud_credentials: false,
  environment_allowlist_only: true,
  filesystem_restricted: true,
  network_default: 'disabled',
  resource_limits: true,
  time_limit: true,
  privilege_escalation: false,
  sudo: false,
  host_configuration_changes: false,
  unrelated_repository_access: false,
  explicit_writable_directories: true,
  command_logging: true,
  file_change_logging: true,
};

const isolationBroker = createProvisionIsolationBroker({
  issuer: 'trusted-host-isolation-broker',
  probe: ({ kind, direct_activation_challenge: directActivationChallenge }) =>
    isolationProbeObservation({
      kind,
      profile: kind === 'instruction-analysis' ? instructionSandbox : executionSandbox,
      directActivationChallenge,
    }),
  analyzeInstructions: async () => ({
    declared_purpose: 'Provide a repository analyzer.',
    useful_learning_points: ['Use deterministic analyzer output.'],
    required_tools: [],
    required_permissions: [],
    verification_methods: ['Verify analyzer identity and version.'],
    unsafe_instructions: [],
    prompt_injection_indicators: [],
    technical_errors: [],
    repository_mismatches: [],
    candidate_fit_score: 95,
    confidence: 0.95,
  }),
  evaluateBehavior: async () => ({
    representative_eval_passed: true,
    sandbox_smoke_test_passed: true,
    evidence_sha256: createHash('sha256').update('scheduler-behavior').digest('hex'),
    command_log_sha256: createHash('sha256').update('scheduler-command-log').digest('hex'),
    file_change_log_sha256: createHash('sha256').update('scheduler-file-log').digest('hex'),
    required_permissions: [],
    license_compatible: true,
    license_evidence_sha256: createHash('sha256').update('scheduler-license').digest('hex'),
    fit: {
      scores: {
        semantic_task_match: 15,
        competence_gain: 15,
        verification_quality: 12,
        failure_mode_coverage: 10,
        repository_compatibility: 8,
        trust_and_provenance: 5,
        methodology_quality: 10,
        tool_compatibility: 8,
        context_efficiency: 7,
        maintenance_quality: 5,
        permission_proportionality: 5,
      },
      confidence: 0.95,
      baseline_expected_success: 0.5,
      candidate_expected_success: 0.9,
      mandatory_competency_missing: false,
    },
  }),
});

const instructionAttestation = createHostSandboxAttestation({
  kind: 'instruction-analysis',
  broker: isolationBroker,
});

const executionAttestation = createHostSandboxAttestation({
  kind: 'execution',
  broker: isolationBroker,
});

const perfectFit = {
  scores: {
    semantic_task_match: 15,
    competence_gain: 15,
    verification_quality: 12,
    failure_mode_coverage: 10,
    repository_compatibility: 8,
    trust_and_provenance: 5,
    methodology_quality: 10,
    tool_compatibility: 8,
    context_efficiency: 7,
    maintenance_quality: 5,
    permission_proportionality: 5,
  },
  confidence: 0.95,
  baselineExpectedSuccess: 0.5,
  candidateExpectedSuccess: 0.9,
  minimumImprovementRequired: 0.1,
  representativeEvalPassed: true,
};

const SCHEDULER_REQUEST = createCapabilityRequest({
  id: 'CAPREQ-001',
  originatingRun: 'scheduler-tests',
  publicSkill: 'refine',
  originSha256: ORIGIN_SHA256,
  repositoryRoot: process.cwd(),
  permissionDecisions: [{
    id: 'D-01',
    granted: true,
    scopes: ['external_discovery', 'acquisition', 'install', 'authenticate'],
    permissions: [],
  }, {
    id: 'D-02',
    granted: true,
    scopes: ['authenticate'],
    permissions: ['connector:read'],
  }],
  task: {
    summary: 'Use a repository-local analyzer.',
    domains: ['engineering'],
    languages: ['JavaScript'],
    frameworks: [],
    consequence_level: 'normal',
  },
  gap: {
    missing_competencies: ['repository analysis'],
    missing_tools: [],
    missing_evidence_methods: [],
    why_base_codex_is_insufficient: ['The requested analyzer is not installed.'],
    expected_improvement: ['Provide deterministic analyzer evidence.'],
    minimum_improvement_required: 0.1,
    expected_success_delta: 0.4,
  },
  constraints: {
    repository: [],
    permissions: ['repository-local capability effects', 'connector:read'],
    maximum_install_scope: 'repository-local',
    authentication_allowed: true,
    external_search_allowed: true,
    latency_priority: 'normal',
  },
});

function schedulerRequestForRoot(id, repositoryRoot) {
  return createCapabilityRequest({
    id,
    originatingRun: SCHEDULER_REQUEST.request.originating_run,
    publicSkill: SCHEDULER_REQUEST.request.public_skill,
    originSha256: ORIGIN_SHA256,
    repositoryRoot,
    permissionDecisions: [{
      id: 'D-01',
      granted: true,
      scopes: ['external_discovery', 'acquisition', 'install', 'authenticate'],
      permissions: [],
    }, {
      id: 'D-02',
      granted: true,
      scopes: ['authenticate'],
      permissions: ['connector:read'],
    }],
    task: SCHEDULER_REQUEST.request.task,
    gap: SCHEDULER_REQUEST.request.gap,
    constraints: SCHEDULER_REQUEST.request.constraints,
  });
}

function installExecutionBroker(execute = async () => ({ exitCode: 0 })) {
  return createProvisionInstallExecutionBroker({
    issuer: 'trusted-cruise-install-execution-broker',
    request: SCHEDULER_REQUEST,
    repositoryRoot: process.cwd(),
    execute: async (contract) => {
      const result = await execute({
        node: contract.node,
        candidate: contract.candidate,
        command: contract.command,
        allowedWritePaths: contract.allowed_write_paths,
      });
      return {
        ok: result?.ok !== false && (result?.exitCode ?? 0) === 0,
        exit_code: result?.exitCode ?? 0,
        identity: result?.identity ?? contract.candidate_identity,
        version: result?.version ?? contract.candidate.version,
        revision: result?.revision ?? contract.candidate.revision,
        command_sha256: contract.command_sha256,
        file_change_log_sha256: createHash('sha256').update(`writes:${contract.capability_id}`).digest('hex'),
        isolation_evidence_sha256: createHash('sha256').update(`isolation:${contract.provision_run_id}`).digest('hex'),
        written_paths: [`${contract.allowed_write_paths[0]}/node_modules/${contract.candidate_identity}`],
      };
    },
  });
}

function smokeVerificationBroker(probe, capabilityRequest = SCHEDULER_REQUEST) {
  return createProvisionSmokeVerificationBroker({
    issuer: 'trusted-cruise-smoke-verification-broker',
    request: capabilityRequest,
    repositoryRoot: capabilityRequestRepositoryRoot(capabilityRequest),
    probe: async (contract) => {
      const result = await probe({
        node: contract.node,
        candidate: contract.candidate,
        installResult: contract.install_result,
      });
      return {
        ...result,
        probe_sha256: createHash('sha256').update(`probe:${contract.capability_id ?? contract.node.id}`).digest('hex'),
        artifact_sha256: createHash('sha256').update(`artifact:${contract.expected_identity ?? 'unknown'}`).digest('hex'),
        observed_paths: [contract.expected_managed_root ?? contract.repository_root],
      };
    },
  });
}

function authVerificationBroker(inspect, capabilityRequest = SCHEDULER_REQUEST) {
  return createProvisionAuthVerificationBroker({
    issuer: 'trusted-cruise-auth-verification-broker',
    request: capabilityRequest,
    repositoryRoot: capabilityRequestRepositoryRoot(capabilityRequest),
    inspectAuthentication: async ({ context }) => {
      const result = await inspect({ context });
      const succeeded = result?.ok === true;
      const state = {
        schema_version: 1,
        kind: 'cruise_auth_job_state',
        id: context.auth_job_id,
        capability_id: context.capability_id,
        request_id: context.request_id,
        request_authority_sha256: context.request_authority_sha256,
        provision_run_id: context.provision_run_id,
        candidate_identity: context.candidate_identity,
        server_name: context.server_name,
        auth_job_sha256: context.auth_job_sha256,
        auth_effect_sha256: context.auth_effect_sha256,
        required_scope: context.required_scope,
        status: succeeded ? 'succeeded' : 'waiting_auth',
        confirmed: succeeded,
        ...(succeeded ? {
          identity: result.identity,
          scope: result.scope,
          smoke_test_passed: true,
          logs_redacted: true,
        } : { reason: result?.reason ?? 'not signed in' }),
      };
      const parsedStateSha256 = stableTestDigest(state);
      const persistedStateSha256 = createHash('sha256')
        .update(`persisted:${parsedStateSha256}`)
        .digest('hex');
      return {
        bound_context: context,
        observed_at: '2026-07-13T00:00:00.000Z',
        evidence_sha256: createHash('sha256').update(`evidence:${persistedStateSha256}`).digest('hex'),
        persisted_state_path: context.auth_state_path,
        persisted_state_sha256: persistedStateSha256,
        parsed_state_sha256: parsedStateSha256,
        state,
        reason: result?.reason ?? null,
      };
    },
  });
}

function rollbackExecutionBroker(rollback = async () => ({ ok: true })) {
  return createProvisionRollbackBroker({
    issuer: 'trusted-cruise-rollback-broker',
    request: SCHEDULER_REQUEST,
    repositoryRoot: process.cwd(),
    rollback: async (contract) => {
      const result = await rollback({
        node: contract.node,
        candidate: contract.candidate,
        installResult: contract.install_result,
      });
      return {
        ok: result?.ok !== false,
        reason: result?.reason ?? null,
        rollback_contract_sha256: contract.rollback_contract_sha256,
        rollback_evidence_sha256: createHash('sha256')
          .update(`rollback:${contract.provision_run_id}:${contract.node.id}`)
          .digest('hex'),
        file_change_log_sha256: createHash('sha256')
          .update(`rollback-writes:${contract.provision_run_id}:${contract.node.id}`)
          .digest('hex'),
        observed_paths: [contract.managed_install_root],
      };
    },
  });
}

function provisionAuthorization(kind, {
  capabilityRequest = SCHEDULER_REQUEST,
  selectionEvaluation = null,
  capabilityId = null,
  permissions = [],
  repository = 'official/tool',
  authJob = null,
  provisionRunId = null,
  candidateIdentity = null,
} = {}) {
  return authorizeProvisionEffect({
    request: capabilityRequest,
    effect: {
      kind,
      install_scope: 'repository-local',
      selection_evaluation: selectionEvaluation,
      capability_id: capabilityId,
      required_permissions: permissions,
      ...(kind === 'acquisition' ? { repository } : {}),
      ...(kind === 'authenticate' ? {
        auth_job: authJob,
        provision_run_id: provisionRunId,
        candidate_identity: candidateIdentity,
      } : {}),
    },
    permission: { id: kind === 'authenticate' ? 'D-02' : 'D-01', granted: true, scopes: [kind], permissions },
    authority: { origin_sha256: ORIGIN_SHA256, public_skill: capabilityRequest.request.public_skill },
  });
}

const ACQUISITION_AUTHORIZATION = provisionAuthorization('acquisition');
const SELECTION_NEED_BROKER = createProvisionNeedAssessmentBroker({
  issuer: 'trusted-cruise-need-assessment-broker',
  assess: async () => ({
    concrete_gap: true,
    base_codex_insufficient: true,
    generic_advice_only: false,
    task_too_small: false,
    implementation_or_verification_quality_changes: true,
    expected_success_delta: 0.4,
    costs: {
      search: 0,
      evaluation: 0,
      context: 0,
      installation: 0,
      authentication: 0,
      maintenance: 0,
      permissions: 0,
      operational_risk: 0,
    },
    evidence_sha256: createHash('sha256').update('scheduler-selection-need').digest('hex'),
  }),
});
const REVIEWED_SELECTION = await runPrivateProvisionSelection({
  request: SCHEDULER_REQUEST,
  nativeProviders: {},
  needAssessmentBroker: SELECTION_NEED_BROKER,
  effectAuthorization: provisionAuthorization('external_discovery'),
  discoverExternal: async () => ({
    external_search: {
      sources: ['hosting-api'],
      queries: ['official tool exact capability'],
      repositories_considered: ['official/tool'],
      repositories_rejected: [],
      stopping_condition: 'one immutable candidate selected',
      saturation_reached: false,
    },
    candidates: [{
      repository: 'official/tool',
      canonical_url: 'https://example.invalid/official/tool',
      commit_sha: REVIEWED_COMMIT,
    }],
  }),
});
const REVIEWED_ACQUISITION = await acquireExternalCandidate({
  request: SCHEDULER_REQUEST,
  selection: REVIEWED_SELECTION,
  effectAuthorization: ACQUISITION_AUTHORIZATION,
  exclusionSnapshot: EXCLUSION_SNAPSHOT,
  repository: 'official/tool',
  selectedPaths: ['SKILL.md'],
  retrievedAt: '2026-07-13T00:00:00.000Z',
  hostingApi: hostingApiBroker({
    getRepositoryMetadata: async () => ({
      canonical_repository: 'official/tool',
      canonical_url: 'https://example.invalid/official/tool',
      stars: 200,
      stars_source: 'hosting-api',
      official: true,
      publisher_verified: true,
      license: 'MIT',
      provenance: { attestation_available: true },
      repository_signals: {
        active_maintainers: 2,
        recent_commits: 12,
        ownership_verified: true,
        release_process: 'reviewed immutable releases',
      },
    }),
    resolveCommit: async () => ({ commit_sha: REVIEWED_COMMIT }),
    getTree: async () => [{ path: 'SKILL.md', kind: 'file', size_bytes: 0 }],
    getBlob: async () => ({ content: '' }),
  }),
});
const REVIEWED_INSTRUCTION_ANALYSIS = await runInstructionSandboxAnalysis({
  acquired: REVIEWED_ACQUISITION,
  instructionSandbox: instructionAttestation,
  exclusionSnapshot: EXCLUSION_SNAPSHOT,
});
const REVIEWED_CANDIDATE_INPUT = {
  identity: 'official-tool',
  version: '1.2.3',
  license_compatible: true,
  install_scope: 'repository-local',
  activation_action: 'install',
  rollback_safe: true,
  rollback_procedure: 'Remove official-tool at the selected repository scope.',
  installer_attestation: INSTALLER_ATTESTATION,
  install_command: {
    file: '/usr/local/bin/npm',
    args: [
      'install', '--ignore-scripts', '--no-save', '--package-lock=false', '--workspaces=false',
      '--prefix', '.cruise/internal/tools/official-tool',
      `https://example.invalid/official/tool#${REVIEWED_COMMIT}`,
    ],
  },
};
const REVIEWED_BEHAVIOR = await runExternalBehaviorEvaluation({
  request: SCHEDULER_REQUEST,
  acquired: REVIEWED_ACQUISITION,
  candidate: REVIEWED_CANDIDATE_INPUT,
  instructionAnalysis: REVIEWED_INSTRUCTION_ANALYSIS,
  executionSandbox: executionAttestation,
  exclusionSnapshot: EXCLUSION_SNAPSHOT,
});
const REVIEWED_EVALUATION = evaluateExternalCandidate({
  request: SCHEDULER_REQUEST,
  acquired: REVIEWED_ACQUISITION,
  candidate: REVIEWED_CANDIDATE_INPUT,
  instructionSandbox: instructionAttestation,
  executionSandbox: executionAttestation,
  instructionAnalysis: REVIEWED_INSTRUCTION_ANALYSIS,
  behaviorEvaluation: REVIEWED_BEHAVIOR,
});
const INSTALL_AUTHORIZATION = provisionAuthorization('install', {
  selectionEvaluation: REVIEWED_EVALUATION,
});
const REVIEWED_CONTENT = REVIEWED_EVALUATION.acquisition.content_sha256;

function node(id, capability, requires = []) {
  return { id, capability, kind: 'cli', requires };
}

function trustedInstallCandidate(overrides = {}) {
  const candidate = {
    action: 'install',
    source: 'https://example.invalid/official/tool',
    repository: 'official/tool',
    identity: 'official-tool',
    identity_verified: true,
    version: '1.2.3',
    reviewed_commit_sha: REVIEWED_COMMIT,
    content_sha256: REVIEWED_CONTENT,
    install_scope: 'repository-local',
    official: true,
    publisher_verified: true,
    installer_attestation: INSTALLER_ATTESTATION,
    command: {
      file: '/usr/local/bin/npm',
      args: [
        'install', '--ignore-scripts', '--no-save', '--package-lock=false', '--workspaces=false',
        '--prefix', '.cruise/internal/tools/official-tool',
        `https://example.invalid/official/tool#${REVIEWED_COMMIT}`,
      ],
    },
    post_install: 'none',
    license: 'MIT',
    license_inspectable: true,
    platform_requirements_inspectable: true,
    auth_required: false,
    requires_secret: false,
    host_permission: true,
    sandbox_allowed: true,
    rollback_safe: true,
    rollback_procedure: 'Remove official-tool at the selected repository scope.',
    request_id: 'CAPREQ-001',
    capability_request: SCHEDULER_REQUEST,
    effect_authorization: INSTALL_AUTHORIZATION,
    ...overrides,
  };
  candidate.selection_evaluation = REVIEWED_EVALUATION;
  return candidate;
}

function useCandidate(overrides = {}) {
  const { authorization_run_id: authorizationRunId = null, ...candidateOverrides } = overrides;
  const candidate = {
    action: 'use',
    source: 'host',
    identity: 'host-tool',
    version: '1.0.0',
    install_scope: 'local',
    auth_required: false,
    request_id: 'CAPREQ-001',
    capability_request: SCHEDULER_REQUEST,
    ...candidateOverrides,
  };
  candidate.request_id = candidate.capability_request.request.id;
  if (candidate.auth_required === true && candidate.auth_job && !candidate.auth_effect_authorization) {
    candidate.auth_effect_authorization = provisionAuthorization('authenticate', {
      capabilityRequest: candidate.capability_request,
      capabilityId: candidate.auth_job.capability_id,
      permissions: candidate.auth_job.validation.required_scope,
      authJob: candidate.auth_job,
      provisionRunId: authorizationRunId,
      candidateIdentity: candidate.identity,
    });
  }
  return candidate;
}

function smokeProof(overrides = {}) {
  return {
    ok: true,
    identity: 'host-tool',
    version: '1.0.0',
    scope: ['read'],
    evidence: 'identity, version, and read-scope probe passed',
    ...overrides,
  };
}

function fallbackApproval(runId, fallback, nodeId = 'CAP-A') {
  const planSha256 = 'd'.repeat(64);
  const permissionsSha256 = 'e'.repeat(64);
  return createCapabilityFallbackApproval({
    issuer: 'trusted-cruise-fallback-approval-broker',
    request: SCHEDULER_REQUEST,
    provisionRunId: runId,
    nodeId,
    decisionId: 'D-50',
    planSha256,
    permissionsSha256,
    readCurrentDigests: () => ({
      plan_sha256: planSha256,
      permissions_sha256: permissionsSha256,
    }),
    fallback,
  });
}

test('creates a deterministic DAG with derived dependents and strict YAML round-trip', () => {
  const run = createProvisionRun({
    runId: 'run-dag',
    nodes: [node('CAP-B', 'extractor', ['CAP-A']), node('CAP-A', 'browser')],
    now: fixedNow,
  });
  assert.deepEqual(run.nodes.map(({ id }) => id), ['CAP-A', 'CAP-B']);
  assert.deepEqual(run.nodes[0].dependents, ['CAP-B']);
  assert.deepEqual(run.resolution_order, [...RESOLUTION_ORDER]);
  assert.deepEqual(parseProvisionYaml(stringifyProvisionYaml(run)), run);
});

test('rejects dependency cycles explicitly', () => {
  assert.throws(
    () =>
      createProvisionRun({
        runId: 'cycle',
        nodes: [node('CAP-A', 'a', ['CAP-B']), node('CAP-B', 'b', ['CAP-A'])],
        now: fixedNow,
      }),
    (error) => {
      assert.ok(error instanceof ProvisionCycleError);
      assert.deepEqual(error.cycle, ['CAP-A', 'CAP-B', 'CAP-A']);
      return true;
    },
  );
});

test('uses fixed resolution precedence and requires smoke proof for an existing capability', async () => {
  const calls = [];
  const run = createProvisionRun({ runId: 'reuse', nodes: [node('CAP-A', 'browser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      host_native: async () => {
        calls.push('host_native');
        return null;
      },
      installed_plugin_or_skill: async () => {
        calls.push('installed_plugin_or_skill');
        return useCandidate({ identity: 'browser-plugin' });
      },
      installed_local: async () => {
        calls.push('installed_local');
        return useCandidate();
      },
    },
    smokeBroker: smokeVerificationBroker(async () => ({
      ok: true,
      identity: 'browser-plugin',
      version: '1.0.0',
      scope: ['read'],
      evidence: 'browser --version',
    })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['host_native', 'installed_plugin_or_skill']);
  assert.equal(result.nodes[0].resolution.selected.strategy, 'installed_plugin_or_skill');
  assert.equal(result.nodes[0].smoke_test.ok, true);
});

test('trusted local install succeeds only after deterministic smoke validation', async () => {
  let installs = 0;
  const run = createProvisionRun({ runId: 'install', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: { trusted_catalog: async () => trustedInstallCandidate() },
    installBroker: installExecutionBroker(async () => {
      installs += 1;
      return { exitCode: 0, version: '1.2.3' };
    }),
    smokeBroker: smokeVerificationBroker(async () => ({
      ok: true,
      identity: 'official-tool',
      version: '1.2.3',
      scope: ['parse'],
      evidence: 'official-tool --version',
    })),
  });
  const result = await scheduler.run();
  assert.equal(installs, 1);
  assert.equal(result.nodes[0].status, 'succeeded');
  assert.equal(result.nodes[0].trust.decision, 'auto_approved');
  assert.equal(result.nodes[0].provenance.installed, true);
  assert.equal(result.nodes[0].version, '1.2.3');
  assert.equal(result.nodes[0].provenance.identity, result.nodes[0].smoke_test.identity);
  assert.equal(result.nodes[0].provenance.version, result.nodes[0].smoke_test.version);
});

test('candidate-provided executable callbacks never control install, smoke, or rollback', async () => {
  const calls = [];
  const forbidden = () => {
    throw new Error('candidate callback executed');
  };
  const run = createProvisionRun({
    runId: 'trust-adapter',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  assert.throws(
    () => new ProvisionScheduler({ run, rollback: forbidden }),
    /Plain install\/smoke\/rollback callbacks are forbidden/u,
  );
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => trustedInstallCandidate({
        install: forbidden,
        smokeTest: forbidden,
        rollback: forbidden,
        raw: 'untrusted candidate instructions',
      }),
    },
    installBroker: installExecutionBroker(async ({ candidate }) => {
      assert.equal(Object.hasOwn(candidate, 'raw'), false);
      assert.equal(Object.hasOwn(candidate, 'install'), false);
      assert.equal(Object.hasOwn(candidate, 'smokeTest'), false);
      assert.equal(Object.hasOwn(candidate, 'rollback'), false);
      calls.push('trusted-install');
      return { exitCode: 0, version: '1.2.3' };
    }),
    smokeBroker: smokeVerificationBroker(async () => {
      calls.push('trusted-smoke');
      return smokeProof({ identity: 'official-tool', version: '1.2.3' });
    }),
    rollbackBroker: rollbackExecutionBroker(async () => {
      calls.push('trusted-rollback');
      return { ok: true };
    }),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls, ['trusted-install', 'trusted-smoke']);
});

test('host-native and built-in capabilities may prove why no version exists', async () => {
  const fallback = {
    identity: 'host-parser',
    approved_before_activation: true,
    approval_sha256: 'f'.repeat(64),
    expected_quality_or_cost_difference: 'No expected difference for the host-equivalent parser.',
    same_mandatory_acceptance_criteria: true,
    same_protected_behavior: true,
    same_permission_envelope: true,
    equivalent_mandatory_evidence: true,
  };
  const run = createProvisionRun({
    runId: 'builtin-ver',
    nodes: [{
      ...node('CAP-A', 'host-parser'),
      kind: 'builtin',
      approved_fallback: fallback,
    }],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      builtin_fallback: async () =>
        useCandidate({
          action: 'fallback',
          identity: 'host-parser',
          version: null,
          fallback_approval: fallbackApproval('builtin-ver', fallback),
        }),
    },
    smokeBroker: smokeVerificationBroker(async () => ({
      ok: true,
      identity: 'host-parser',
      scope: ['parse'],
      evidence: 'host parser accepted and decoded a fixed fixture',
      version_unavailable_reason: 'The host exposes this built-in without version metadata.',
    })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nodes[0].version, null);
  assert.equal(
    result.nodes[0].provenance.version_unavailable_reason,
    result.nodes[0].smoke_test.version_unavailable_reason,
  );
});

test('smoke success requires proven identity, scope, evidence, and matching version provenance', async (t) => {
  const cases = [
    ['identity', useCandidate(), smokeProof({ identity: ' ' })],
    ['scope', useCandidate(), smokeProof({ scope: [] })],
    ['unusable scope', useCandidate(), smokeProof({ scope: { read: false } })],
    ['evidence', useCandidate(), smokeProof({ evidence: ' ' })],
    ['unstructured evidence assertion', useCandidate(), smokeProof({ evidence: true })],
    [
      'version',
      useCandidate({ version: null }),
      smokeProof({ version: undefined, version_unavailable_reason: undefined }),
    ],
    [
      'non-host version exemption',
      useCandidate({ version: null }),
      smokeProof({
        version: undefined,
        version_unavailable_reason: 'This resolver did not report a version.',
      }),
    ],
    ['identity mismatch', useCandidate(), smokeProof({ identity: 'different-tool' })],
    ['version mismatch', useCandidate(), smokeProof({ version: '2.0.0' })],
  ];

  for (const [index, [label, candidate, proof]] of cases.entries()) {
    await t.test(label, async () => {
      const run = createProvisionRun({
        runId: `smoke-neg-${index + 1}`,
        nodes: [node('CAP-A', 'host-tool')],
        now: fixedNow,
      });
      const scheduler = new ProvisionScheduler({
        run,
        now: fixedNow,
        resolvers: { installed_plugin_or_skill: async () => candidate },
        smokeBroker: smokeVerificationBroker(async () => proof),
      });
      const result = await scheduler.run();
      assert.equal(result.status, 'failed');
      assert.equal(result.nodes[0].blocking_reason, 'CRUISE_PROVISION_SMOKE_FAILED');
      assert.equal(result.nodes[0].provenance, null);
      assert.equal(
        result.nodes[0].attempts[0].steps.some(
          ({ stage, outcome }) => stage === 'smoke_test' && outcome === 'failed',
        ),
        true,
      );
    });
  }
});

test('installer exit zero cannot bypass a failed smoke test and safe rollback runs', async () => {
  let rollbacks = 0;
  const run = createProvisionRun({ runId: 'smoke-fail', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: { trusted_catalog: async () => trustedInstallCandidate() },
    installBroker: installExecutionBroker(async () => ({ exitCode: 0 })),
    smokeBroker: smokeVerificationBroker(async () => ({ ok: false, reason: 'binary identity mismatch' })),
    rollbackBroker: rollbackExecutionBroker(async () => {
      rollbacks += 1;
      return { ok: true };
    }),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.nodes[0].status, 'failed');
  assert.equal(result.nodes[0].blocking_reason, 'CRUISE_PROVISION_SMOKE_FAILED');
  assert.equal(rollbacks, 1);
  assert.equal(
    result.nodes[0].attempts[0].steps.some(
      ({ stage, outcome }) => stage === 'rollback' && outcome === 'succeeded',
    ),
    true,
  );
});

test('rollback broker rejects recovery evidence outside the exact managed installation root', async () => {
  const run = createProvisionRun({
    runId: 'rollback-path',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  const rollbackBroker = createProvisionRollbackBroker({
    issuer: 'trusted-cruise-rollback-broker',
    request: SCHEDULER_REQUEST,
    repositoryRoot: process.cwd(),
    rollback: async (contract) => ({
      ok: true,
      rollback_contract_sha256: contract.rollback_contract_sha256,
      rollback_evidence_sha256: 'a'.repeat(64),
      file_change_log_sha256: 'b'.repeat(64),
      observed_paths: ['/tmp/outside-cruise-managed-root'],
    }),
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: { trusted_catalog: async () => trustedInstallCandidate() },
    installBroker: installExecutionBroker(async () => ({ exitCode: 0 })),
    smokeBroker: smokeVerificationBroker(async () => ({ ok: false, reason: 'forced verification failure' })),
    rollbackBroker,
  });
  const result = await scheduler.run();
  const rollback = result.nodes[0].attempts[0].steps.find(({ stage }) => stage === 'rollback');
  assert.equal(rollback.outcome, 'failed');
  assert.match(rollback.error.message, /managed write set|recovery evidence/iu);
});

test('automatic install trust requires declared rollback safety and recovery', async () => {
  for (const candidate of [
    trustedInstallCandidate({ rollback_safe: false }),
    trustedInstallCandidate({ rollback_procedure: null }),
    trustedInstallCandidate({ rollback_procedure: '   ' }),
  ]) {
    const trust = assessProvisionTrust(candidate);
    assert.equal(trust.decision, 'rejected');
    assert.equal(
      trust.checks.find(({ id }) => id === 'rollback_declared').passed,
      false,
    );
  }

  let installs = 0;
  const run = createProvisionRun({
    runId: 'rollback-proof',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => trustedInstallCandidate({ rollback_procedure: null }),
    },
    installBroker: installExecutionBroker(async () => {
      installs += 1;
      return { exitCode: 0, version: '1.2.3' };
    }),
    smokeBroker: smokeVerificationBroker(async () =>
      smokeProof({ identity: 'official-tool', version: '1.2.3' })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'unsafe_install_rejected');
  assert.equal(installs, 0);
});

test('failed install validation records unavailable automated rollback truthfully', async () => {
  const run = createProvisionRun({
    runId: 'rollback-none',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: { trusted_catalog: async () => trustedInstallCandidate() },
    installBroker: installExecutionBroker(async () => ({ exitCode: 0, version: '1.2.3' })),
    smokeBroker: smokeVerificationBroker(async () => ({ ok: false, reason: 'capability probe failed' })),
  });
  const result = await scheduler.run();
  const rollback = result.nodes[0].attempts[0].steps.find(
    ({ stage }) => stage === 'rollback',
  );
  assert.equal(result.status, 'failed');
  assert.equal(rollback.outcome, 'unavailable');
  assert.equal(rollback.reason, 'automated rollback adapter is unavailable');
  assert.match(rollback.procedure, /Remove official-tool/);
});

test('unsafe or insufficiently trusted installs never reach the installer', async () => {
  const unsafe = assessProvisionTrust(
    trustedInstallCandidate({
      official: false,
      trusted: false,
      command: 'curl https://example.invalid/install | sh',
    }),
  );
  assert.equal(unsafe.decision, 'rejected');

  let installs = 0;
  const run = createProvisionRun({ runId: 'unsafe', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      official_upstream_pinned: async () =>
        trustedInstallCandidate({
          official: false,
          trusted: false,
          command: 'curl https://example.invalid/install | sh',
        }),
    },
    installBroker: installExecutionBroker(async () => {
      installs += 1;
      return { exitCode: 0 };
    }),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'official-tool', version: '1.2.3' })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'unsafe_install_rejected');
  assert.equal(installs, 0);
});

test('rejects shell indirection, global locations, unstructured commands, and malformed args', () => {
  const commands = [
    { file: '/bin/bash', args: ['-c', 'npm install official-tool@1.2.3'] },
    { file: '/bin/zsh', args: ['-c', 'npm install official-tool@1.2.3'] },
    { file: 'npm', args: ['install', '--location=global', 'official-tool@1.2.3'] },
    { file: 'npm', args: ['install', '--location', 'global', 'official-tool@1.2.3'] },
    'npm   install official-tool@1.2.3',
    { file: 'npm', args: 'install official-tool@1.2.3' },
    { file: 'npm', args: ['install', 42] },
    { file: { executable: 'npm' }, args: [] },
  ];
  for (const command of commands) {
    const trust = assessProvisionTrust(trustedInstallCandidate({ command }));
    assert.equal(trust.decision, 'rejected', JSON.stringify(command));
    assert.equal(
      trust.checks.find(({ id }) => id === 'command_inspectable').passed,
      false,
      JSON.stringify(command),
    );
  }
});

test('otherwise safe but untrusted installation cannot bypass direct-use eligibility', async () => {
  let installs = 0;
  const run = createProvisionRun({ runId: 'approval', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () =>
        trustedInstallCandidate({ official: false, trusted: false }),
    },
    installBroker: installExecutionBroker(async () => {
      installs += 1;
      return { exitCode: 0 };
    }),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'official-tool', version: '1.2.3' })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'unsafe_install_rejected');
  assert.equal(result.nodes[0].trust.decision, 'rejected');
  assert.equal(installs, 0);
});

test('empty trusted-catalog entries cannot authorize arbitrary installers', () => {
  const trust = assessProvisionTrust(
    trustedInstallCandidate({ official: false, trusted: false }),
    { trustedCatalog: [{}] },
  );
  assert.equal(trust.decision, 'rejected');
});

test('external use cannot bypass the opaque private selection evaluation', async () => {
  const run = createProvisionRun({
    runId: 'ext-use',
    nodes: [node('CAP-A', 'external-analyzer')],
    now: fixedNow,
  });
  let smokeCalls = 0;
  let resolverCalls = 0;
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => useCandidate({
        source: 'https://example.invalid/external/analyzer',
        repository: 'external/analyzer',
        identity: 'external-analyzer',
        reviewed_commit_sha: REVIEWED_COMMIT,
        content_sha256: REVIEWED_CONTENT,
        external_candidate: true,
      }),
    },
    smokeBroker: smokeVerificationBroker(async () => {
      smokeCalls += 1;
      return smokeProof();
    }),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'unsafe_capability_rejected');
  assert.equal(smokeCalls, 0);
});

test('native scheduler candidates require the exact opaque CAPREQ object', async () => {
  const reissuedRequest = createCapabilityRequest({
    id: SCHEDULER_REQUEST.request.id,
    originatingRun: SCHEDULER_REQUEST.request.originating_run,
    publicSkill: SCHEDULER_REQUEST.request.public_skill,
    originSha256: ORIGIN_SHA256,
    repositoryRoot: process.cwd(),
    permissionDecisions: [{
      id: 'D-01',
      granted: true,
      scopes: ['acquisition', 'install', 'authenticate'],
      permissions: [],
    }, {
      id: 'D-02',
      granted: true,
      scopes: ['authenticate'],
      permissions: ['connector:read'],
    }],
    task: SCHEDULER_REQUEST.request.task,
    gap: SCHEDULER_REQUEST.request.gap,
    constraints: SCHEDULER_REQUEST.request.constraints,
  });
  for (const substitutedRequest of [structuredClone(SCHEDULER_REQUEST), reissuedRequest]) {
    const run = createProvisionRun({
      runId: substitutedRequest === reissuedRequest ? 'reissued-capreq' : 'cloned-capreq',
      nodes: [node('CAP-A', 'host-tool')],
      now: fixedNow,
    });
    const scheduler = new ProvisionScheduler({
      run,
      now: fixedNow,
      resolvers: {
        host_native: async () => useCandidate({ capability_request: substitutedRequest }),
      },
      smokeBroker: smokeVerificationBroker(async () => { throw new Error('must not run'); }),
    });
    const result = await scheduler.run();
    assert.equal(result.nodes[0].status, 'blocked');
    assert.equal(result.nodes[0].blocking_reason, 'capability_request_run_mismatch');
  }
});

test('opaque selection and effect authorization bind exact action, scope, identity, version, and install command', async () => {
  for (const overrides of [
    { install_scope: 'repository' },
    { install_scope: 'virtualenv' },
    { version: '9.9.9' },
    { identity: 'other-tool' },
    { command: { file: 'npm', args: ['install', 'other-tool@9.9.9'] } },
    { action: 'use', strategy: 'trusted_catalog' },
  ]) {
    const trust = assessProvisionTrust(trustedInstallCandidate(overrides));
    assert.equal(trust.decision, 'rejected', JSON.stringify(overrides));
    assert.equal(trust.checks.find(({ id }) => id === 'selection_gate').passed, false);
    assert.equal(trust.checks.find(({ id }) => id === 'effect_authorization').passed, false);
  }
  let installs = 0;
  const scheduler = new ProvisionScheduler({
    run: createProvisionRun({ runId: 'install-plan', nodes: [node('CAP-A', 'analyzer')], now: fixedNow }),
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => trustedInstallCandidate({
        command: { file: 'npm', args: ['install', 'other-tool@9.9.9'] },
      }),
    },
    installBroker: installExecutionBroker(async () => { installs += 1; return { exitCode: 0 }; }),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'other-tool', version: '9.9.9' })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(installs, 0);
});

test('scheduler exclusions apply before activation or privileged adapter context', async () => {
  const run = createProvisionRun({
    runId: 'sched-excl',
    nodes: [node('CAP-A', 'excluded-tool')],
    now: fixedNow,
  });
  let smokeCalls = 0;
  let resolverCalls = 0;
  const scheduler = new ProvisionScheduler({
    run,
    exclusions: ['excluded-tool'],
    now: fixedNow,
    resolvers: { host_native: async () => {
      resolverCalls += 1;
      return useCandidate({ identity: 'excluded-tool' });
    } },
    smokeBroker: smokeVerificationBroker(async () => {
      smokeCalls += 1;
      return smokeProof();
    }),
  });
  const result = await scheduler.run();
  assert.equal(result.nodes[0].status, 'excluded');
  assert.equal(result.nodes[0].blocking_reason, 'capability_excluded');
  assert.equal(result.nodes[0].resolution.selected, null);
  assert.equal(result.nodes[0].trust, null);
  assert.equal(result.nodes[0].provenance, null);
  assert.equal(result.nodes[0].attempts[0].outcome, 'excluded');
  assert.equal(smokeCalls, 0);
  assert.equal(resolverCalls, 0);
});

test('scheduler refreshes repository revocations after resolution and before adapters', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-provision-live-revocation-')));
  const capabilityRequest = schedulerRequestForRoot('CAPREQ-246', root);
  const store = new ProvisionStateStore({ root, now: fixedNow });
  const run = createProvisionRun({
    runId: 'revoke-use',
    requestId: capabilityRequest.request.id,
    capabilityRequest,
    nodes: [node('CAP-A', 'use-capability')],
    now: fixedNow,
  });
  let adapterCalls = 0;
  const scheduler = new ProvisionScheduler({
    run,
    store,
    now: fixedNow,
    resolvers: {
      host_native: async () => {
        await writeFile(join(root, '.cruise', 'skills', 'exclude'), 'host-tool\n', { mode: 0o600 });
        return useCandidate({ capability_request: capabilityRequest });
      },
    },
    smokeBroker: smokeVerificationBroker(async () => {
      adapterCalls += 1;
      return smokeProof();
    }, capabilityRequest),
  });
  const result = await scheduler.run();
  assert.equal(result.nodes[0].status, 'excluded');
  assert.equal(result.nodes[0].blocking_reason, 'capability_excluded');
  assert.equal(adapterCalls, 0);
});

test('scheduler rejects cross-repository and forged state stores before revocation reads or persistence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-provision-store-authority-')));
  const foreignRoot = await realpath(await mkdtemp(join(tmpdir(), 'cruise-provision-foreign-store-')));
  const capabilityRequest = schedulerRequestForRoot('CAPREQ-247', root);
  const run = createProvisionRun({
    runId: 'store-authority',
    requestId: capabilityRequest.request.id,
    capabilityRequest,
    nodes: [node('CAP-A', 'revoked-tool')],
    now: fixedNow,
  });
  const store = new ProvisionStateStore({ root, now: fixedNow });
  const foreignStore = new ProvisionStateStore({ root: foreignRoot, now: fixedNow });
  const forgedStore = {
    requestedRoot: root,
    root,
    loadExclusions: async () => [],
    loadRejectedCapabilities: async () => [],
    saveRun: async () => null,
  };

  for (const invalidStore of [foreignStore, forgedStore]) {
    assert.throws(
      () => new ProvisionScheduler({ run, capabilityRequest, store: invalidStore }),
      /exact opaque store for the CAPREQ repository root/iu,
    );
  }

  await store.loadExclusions();
  await writeFile(join(root, '.cruise', 'skills', 'exclude'), 'revoked-tool\n', { mode: 0o600 });
  let adapterCalls = 0;
  const scheduler = new ProvisionScheduler({
    run,
    capabilityRequest,
    store,
    now: fixedNow,
    resolvers: {
      host_native: async () => useCandidate({
        identity: 'revoked-tool',
        capability_request: capabilityRequest,
      }),
    },
    smokeBroker: smokeVerificationBroker(async () => {
      adapterCalls += 1;
      return smokeProof({ identity: 'revoked-tool' });
    }, capabilityRequest),
  });
  const result = await scheduler.run();
  assert.equal(result.nodes[0].status, 'excluded');
  assert.equal(adapterCalls, 0);
  await access(join(root, '.cruise', 'internal', 'provision-runs', 'store-authority', 'state.yaml'));
  await assert.rejects(
    access(join(foreignRoot, '.cruise', 'internal', 'provision-runs', 'store-authority', 'state.yaml')),
    /ENOENT/,
  );
});

test('trust and node-bound auth are validated before entering waiting_auth', async () => {
  const run = createProvisionRun({
    runId: 'auth-trust',
    nodes: [node('CAP-A', 'external-analyzer')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => {
        const candidate = trustedInstallCandidate({
          auth_required: true,
          auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-A', serverName: 'external-analyzer', requiredScopes: ['connector:read'] }),
        });
        candidate.selection_evaluation = {};
        return candidate;
      },
    },
  });
  const rejected = await scheduler.run();
  assert.equal(rejected.nodes[0].status, 'blocked');
  assert.equal(rejected.nodes[0].blocking_reason, 'unsafe_install_rejected');

  const hostRun = createProvisionRun({
    runId: 'auth-node',
    nodes: [node('CAP-A', 'host-connector')],
    now: fixedNow,
  });
  const mismatched = new ProvisionScheduler({
    run: hostRun,
    now: fixedNow,
    resolvers: {
      host_native: async () => useCandidate({
        identity: 'host-connector',
        auth_required: true,
        authorization_run_id: 'auth-node',
        auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-B', serverName: 'host-connector', requiredScopes: ['connector:read'] }),
      }),
    },
  });
  const invalid = await mismatched.run();
  assert.equal(invalid.nodes[0].status, 'blocked');
  assert.equal(invalid.nodes[0].blocking_reason, 'auth_job_invalid');

  const scopeRun = createProvisionRun({
    runId: 'auth-scope',
    nodes: [node('CAP-A', 'host-connector')],
    now: fixedNow,
  });
  const mismatchedScope = new ProvisionScheduler({
    run: scopeRun,
    now: fixedNow,
    resolvers: {
      host_native: async () => useCandidate({
        identity: 'host-connector',
        auth_required: true,
        authorization_run_id: 'auth-scope',
        auth_job: createAuthJob({
          id: 'AUTH-001',
          capabilityId: 'CAP-A',
          serverName: 'host-connector',
          requiredScopes: ['connector:write'],
        }),
      }),
    },
  });
  const invalidScope = await mismatchedScope.run();
  assert.equal(invalidScope.nodes[0].status, 'blocked');
  assert.equal(invalidScope.nodes[0].blocking_reason, 'auth_job_invalid');
});

test('preferred and mandatory fallback must be preapproved and equivalent', async () => {
  const makeScheduler = (runId, approved_fallback, authorityFallback = null) => new ProvisionScheduler({
    run: createProvisionRun({
      runId,
      nodes: [{ ...node('CAP-A', 'parser'), necessity: 'preferred', approved_fallback }],
      now: fixedNow,
    }),
    now: fixedNow,
    resolvers: {
      builtin_fallback: async () => useCandidate({
        action: 'fallback',
        identity: 'host-parser',
        version: null,
        ...(authorityFallback == null ? {} : {
          fallback_approval: fallbackApproval(runId, authorityFallback),
        }),
      }),
    },
    smokeBroker: smokeVerificationBroker(async () => ({
      ok: true,
      identity: 'host-parser',
      scope: ['parse'],
      evidence: 'fixed parser fixture passed',
      version_unavailable_reason: 'The host built-in has no version metadata.',
    })),
  });
  const blocked = await makeScheduler('fallback-no', null).run();
  assert.equal(blocked.nodes[0].blocking_reason, 'fallback_not_preapproved_or_equivalent');
  const approvedFallback = {
    identity: 'host-parser',
    approved_before_activation: true,
    approval_sha256: 'f'.repeat(64),
    expected_quality_or_cost_difference: 'Uses the built-in parser with equivalent evidence.',
    same_mandatory_acceptance_criteria: true,
    same_protected_behavior: true,
    same_permission_envelope: true,
    equivalent_mandatory_evidence: true,
  };
  const tampered = await makeScheduler(
    'fallback-bad',
    { ...approvedFallback, approval_sha256: 'tampered' },
    approvedFallback,
  ).run();
  assert.equal(tampered.nodes[0].blocking_reason, 'fallback_not_preapproved_or_equivalent');
  const approved = await makeScheduler('fallback-ok', approvedFallback, approvedFallback).run();
  assert.equal(approved.status, 'succeeded');
});

test('required capability nodes cannot accept a skip resolution', async () => {
  assert.throws(
    () => createProvisionRun({
      runId: 'must-needed',
      nodes: [{ ...node('CAP-A', 'parser'), necessity: 'mandatory', required_for_completion: false }],
      now: fixedNow,
    }),
    /mandatory necessity must be required for completion/,
  );
  const run = createProvisionRun({
    runId: 'required-skip',
    nodes: [node('CAP-A', 'required-parser')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      builtin_fallback: async () => ({
        ...useCandidate({
          action: 'skip',
          source: 'none',
          reason: 'parser was treated as optional',
        }),
      }),
    },
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'required_capability_cannot_skip');
});

test('persisted or caller-forged success never satisfies the DAG without revalidation', async () => {
  const forged = createProvisionRun({
    runId: 'forged-success',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  forged.nodes[0].status = 'succeeded';
  forged.status = 'succeeded';
  assert.throws(
    () => new ProvisionScheduler({ run: forged }),
    /succeeded status lacks smoke and provenance evidence/,
  );

  const persisted = createProvisionRun({
    runId: 'saved-success',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  persisted.nodes[0].status = 'succeeded';
  persisted.nodes[0].smoke_test = { ok: true, identity: 'forged-parser' };
  persisted.nodes[0].provenance = { identity: 'forged-parser' };
  persisted.status = 'succeeded';
  let smokeCalls = 0;
  const scheduler = new ProvisionScheduler({
    run: persisted,
    now: fixedNow,
    resolvers: { host_native: async () => useCandidate({ identity: 'parser' }) },
    smokeBroker: smokeVerificationBroker(async () => {
      smokeCalls += 1;
      return smokeProof({ identity: 'parser' });
    }),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(smokeCalls, 1);
  assert.equal(result.nodes[0].attempts.some(
    ({ outcome }) => outcome === 'persisted_success_revalidation_required'), true);
  assert.equal(result.nodes[0].smoke_test.identity, 'parser');
});

test('an independent optional node may skip without preventing required completion', async () => {
  const run = createProvisionRun({
    runId: 'optional-skip',
    nodes: [
      node('CAP-A', 'required-parser'),
      { ...node('CAP-B', 'optional-formatter'), required_for_completion: false },
    ],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      host_native: async ({ node: current }) =>
        current.id === 'CAP-B'
          ? useCandidate({ action: 'skip', source: 'none', reason: 'optional formatter unavailable' })
          : useCandidate({ identity: current.capability }),
    },
    smokeBroker: smokeVerificationBroker(async ({ node: current }) => smokeProof({ identity: current.capability })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nodes.find(({ id }) => id === 'CAP-A').status, 'succeeded');
  assert.equal(result.nodes.find(({ id }) => id === 'CAP-B').status, 'skipped');
});

test('a skipped optional dependency never releases its dependent', async () => {
  const run = createProvisionRun({
    runId: 'skip-dep',
    nodes: [
      { ...node('CAP-A', 'optional-source'), required_for_completion: false },
      node('CAP-B', 'required-consumer', ['CAP-A']),
    ],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      host_native: async ({ node: current }) =>
        current.id === 'CAP-A'
          ? useCandidate({ action: 'skip', source: 'none', reason: 'source unavailable' })
          : useCandidate({ identity: current.capability }),
    },
    smokeBroker: smokeVerificationBroker(async ({ node: current }) => smokeProof({ identity: current.capability })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes.find(({ id }) => id === 'CAP-A').status, 'skipped');
  const dependent = result.nodes.find(({ id }) => id === 'CAP-B');
  assert.equal(dependent.status, 'blocked');
  assert.equal(dependent.blocking_reason, 'dependency_skipped:CAP-A');
  assert.equal(dependent.attempts.length, 0);
});

test('auth wait pauses descendants, completes independent siblings, and resumes only after identity/scope validation', async () => {
  const installs = [];
  let authChecks = 0;
  const run = createProvisionRun({
    runId: 'auth-dag',
    nodes: [
      node('CAP-A', 'private-connector'),
      node('CAP-B', 'dependent-research', ['CAP-A']),
      node('CAP-C', 'independent-parser'),
    ],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    authPollIntervalMs: 0,
    resolvers: {
      host_native: async ({ node: current }) => {
        if (current.id === 'CAP-A') {
          return useCandidate({
            identity: 'private-connector',
            auth_required: true,
            authorization_run_id: 'auth-dag',
            auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-A', serverName: 'private-connector', requiredScopes: ['connector:read'] }),
          });
        }
        return useCandidate({ identity: current.capability });
      },
    },
    installBroker: installExecutionBroker(async ({ node: current }) => {
      installs.push(current.id);
      return { exitCode: 0 };
    }),
    smokeBroker: smokeVerificationBroker(async ({ node: current }) => ({
      ok: true,
      identity: current.capability,
      version: '1.0.0',
      scope: ['read'],
      evidence: `${current.capability} identity and read-scope probe passed`,
    })),
    authBroker: authVerificationBroker(async () => {
      authChecks += 1;
      if (authChecks < 3) return { ok: false, reason: 'not signed in' };
      return { ok: true, identity: 'user@example.invalid', scope: ['connector:read'] };
    }),
  });

  const first = await scheduler.run();
  assert.equal(first.status, 'waiting_auth');
  assert.equal(first.nodes.find(({ id }) => id === 'CAP-A').status, 'waiting_auth');
  assert.equal(first.nodes.find(({ id }) => id === 'CAP-B').status, 'pending');
  assert.equal(first.nodes.find(({ id }) => id === 'CAP-C').status, 'succeeded');
  assert.deepEqual(installs, []);

  const bounded = await scheduler.waitForAuthentication('CAP-A', { maxChecks: 2, intervalMs: 0 });
  assert.equal(bounded.verified, false);
  assert.equal(authChecks, 2);
  assert.equal(scheduler.getNode('CAP-A').status, 'waiting_auth');

  const verified = await scheduler.waitForAuthentication('CAP-A', { maxChecks: 1, intervalMs: 0 });
  assert.equal(verified.verified, true);
  assert.equal(verified.node.auth.identity, 'user@example.invalid');
  const final = await scheduler.run();
  assert.equal(final.status, 'succeeded');
  assert.equal(final.nodes.find(({ id }) => id === 'CAP-A').status, 'succeeded');
  assert.equal(final.nodes.find(({ id }) => id === 'CAP-B').status, 'succeeded');
});

test('scheduler rejects plain or forged auth checkers and blocks drifted opaque auth evidence', async () => {
  assert.throws(
    () => new ProvisionScheduler({
      run: createProvisionRun({ runId: 'plain-auth', nodes: [node('CAP-A', 'private')], now: fixedNow }),
      authCheck: async () => ({ ok: true, identity: 'forged', scope: ['connector:read'] }),
    }),
    /Plain .*auth callbacks are forbidden/iu,
  );

  const authJob = createAuthJob({
    id: 'AUTH-071',
    capabilityId: 'CAP-A',
    serverName: 'drift-connector',
    requiredScopes: ['connector:read'],
  });
  const candidate = () => useCandidate({
    identity: 'drift-connector',
    auth_required: true,
    authorization_run_id: 'auth-drift',
    auth_job: authJob,
  });
  let drifted = false;
  const broker = authVerificationBroker(async () => ({
    ok: true,
    identity: drifted ? 'different-user' : 'signed-in-user',
    scope: ['connector:read'],
  }));
  const scheduler = new ProvisionScheduler({
    run: createProvisionRun({ runId: 'auth-drift', nodes: [node('CAP-A', 'private')], now: fixedNow }),
    now: fixedNow,
    authBroker: broker,
    resolvers: { host_native: async () => candidate() },
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'drift-connector' })),
  });
  assert.equal((await scheduler.run()).status, 'waiting_auth');
  await assert.rejects(
    scheduler.checkAuthentication('CAP-A', { authBroker: structuredClone(broker) }),
    /exact opaque request-bound broker/iu,
  );
  assert.equal((await scheduler.checkAuthentication('CAP-A')).verified, true);
  drifted = true;
  const blocked = await scheduler.run();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.nodes[0].blocking_reason, 'authenticated_evidence_drift');
});

test('declined authentication uses only an approved equivalent preferred fallback and blocks mandatory loss', async () => {
  const fallback = {
    identity: 'host-parser',
    approved_before_activation: true,
    approval_sha256: 'f'.repeat(64),
    expected_quality_or_cost_difference: 'Equivalent local parser avoids the authenticated connector.',
    same_mandatory_acceptance_criteria: true,
    same_protected_behavior: true,
    same_permission_envelope: true,
    equivalent_mandatory_evidence: true,
  };
  const preferred = new ProvisionScheduler({
    run: createProvisionRun({
      runId: 'pref-decline',
      nodes: [{ ...node('CAP-A', 'private-parser'), necessity: 'preferred', approved_fallback: fallback }],
      now: fixedNow,
    }),
    now: fixedNow,
    resolvers: {
      host_native: async () => useCandidate({
        identity: 'private-parser',
        auth_required: true,
        authorization_run_id: 'pref-decline',
        auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-A', serverName: 'private-parser', requiredScopes: ['connector:read'] }),
      }),
      builtin_fallback: async () => useCandidate({
        action: 'fallback',
        identity: 'host-parser',
        version: null,
        fallback_approval: fallbackApproval('pref-decline', fallback),
      }),
    },
    smokeBroker: smokeVerificationBroker(async () => ({
      ok: true,
      identity: 'host-parser',
      scope: ['parse'],
      evidence: 'equivalent fallback fixture passed',
      version_unavailable_reason: 'Host parser version is unavailable.',
    })),
  });
  assert.equal((await preferred.run()).status, 'waiting_auth');
  await preferred.declineAuthentication('CAP-A');
  const preferredResult = await preferred.run();
  assert.equal(preferredResult.status, 'succeeded');
  assert.equal(preferredResult.nodes[0].outcome.reconciliation.outcome, 'equivalent_fallback');

  const mandatory = new ProvisionScheduler({
    run: createProvisionRun({
      runId: 'must-decline',
      nodes: [{ ...node('CAP-A', 'private-parser'), necessity: 'mandatory' }],
      now: fixedNow,
    }),
    now: fixedNow,
    resolvers: {
      host_native: async () => useCandidate({
        identity: 'private-parser',
        auth_required: true,
        authorization_run_id: 'must-decline',
        auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-A', serverName: 'private-parser', requiredScopes: ['connector:read'] }),
      }),
    },
  });
  assert.equal((await mandatory.run()).status, 'waiting_auth');
  await mandatory.declineAuthentication('CAP-A');
  const mandatoryResult = await mandatory.run();
  assert.equal(mandatoryResult.status, 'blocked');
  assert.equal(mandatoryResult.nodes[0].blocking_reason, 'no_trusted_resolution');
});

test('persisted waiting-auth run resumes in a fresh scheduler and revalidates capability', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-provision-auth-resume-')));
  const capabilityRequest = schedulerRequestForRoot('CAPREQ-713', root);
  const store = new ProvisionStateStore({ root, now: fixedNow });
  const run = createProvisionRun({
    runId: 'auth-resume',
    requestId: capabilityRequest.request.id,
    capabilityRequest,
    nodes: [node('CAP-A', 'private-connector'), node('CAP-B', 'research', ['CAP-A'])],
    now: fixedNow,
  });
  const resolvers = {
    host_native: async ({ node: current }) =>
      current.id === 'CAP-A'
        ? useCandidate({
            identity: 'private-connector',
            capability_request: capabilityRequest,
            auth_required: true,
            authorization_run_id: 'auth-resume',
            auth_job: createAuthJob({ id: 'AUTH-001', capabilityId: 'CAP-A', serverName: 'private-connector', requiredScopes: ['connector:read'] }),
          })
        : useCandidate({ identity: current.capability, capability_request: capabilityRequest }),
  };
  const smokeBroker = smokeVerificationBroker(async ({ node: current }) => ({
    ok: true,
    identity: current.capability,
    version: '1.0.0',
    scope: ['read'],
    evidence: `${current.capability} identity and read-scope probe passed`,
  }), capabilityRequest);
  const firstScheduler = new ProvisionScheduler({
    run,
    resolvers,
    smokeBroker,
    store,
    now: fixedNow,
  });
  const waiting = await firstScheduler.run();
  assert.equal(waiting.status, 'waiting_auth');

  const loaded = await store.loadRun('auth-resume', { capabilityRequest });
  const resumedAuthJob = createAuthJob({
    id: 'AUTH-001',
    capabilityId: 'CAP-A',
    serverName: 'private-connector',
    requiredScopes: ['connector:read'],
  });
  const resumedAuthEffect = provisionAuthorization('authenticate', {
    capabilityRequest,
    capabilityId: 'CAP-A',
    permissions: resumedAuthJob.validation.required_scope,
    authJob: resumedAuthJob,
    provisionRunId: 'auth-resume',
    candidateIdentity: 'private-connector',
  });
  const resumed = new ProvisionScheduler({
    run: loaded,
    capabilityRequest,
    resolvers,
    smokeBroker,
    store,
    now: fixedNow,
    authBroker: authVerificationBroker(async () => ({
      ok: true,
      identity: 'signed-in-user',
      scope: ['connector:read'],
    }), capabilityRequest),
  });
  const auth = await resumed.checkAuthentication('CAP-A', {
    authEffectAuthorization: resumedAuthEffect,
    authJob: resumedAuthJob,
  });
  assert.equal(auth.verified, true);
  const final = await resumed.run();
  assert.equal(final.status, 'succeeded');
  assert.equal(final.nodes.find(({ id }) => id === 'CAP-B').status, 'succeeded');
});

test('auth cannot silently bypass a missing structured native job', async () => {
  const run = createProvisionRun({ runId: 'auth-action', nodes: [node('CAP-A', 'private')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      installed_plugin_or_skill: async () => useCandidate({ auth_required: true }),
    },
    smokeBroker: smokeVerificationBroker(async () => smokeProof()),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'auth_job_invalid');
});

test('candidate that directly requires secret material is rejected without auth or install', async () => {
  let installs = 0;
  const run = createProvisionRun({ runId: 'secret-required', nodes: [node('CAP-A', 'private')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      official_codex_plugin: async () =>
        trustedInstallCandidate({
          auth_required: true,
          requires_secret: true,
          auth_action: 'Paste a reusable token.',
        }),
    },
    installBroker: installExecutionBroker(async () => {
      installs += 1;
      return { exitCode: 0 };
    }),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'official-tool', version: '1.2.3' })),
  });
  const result = await scheduler.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.nodes[0].blocking_reason, 'reusable_secret_required');
  assert.equal(installs, 0);
});

test('blocked resolutions consume the bounded retry budget', async () => {
  const run = createProvisionRun({ runId: 'bounded-retry', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    maxAttempts: 2,
    resolvers: {
      trusted_catalog: async () => trustedInstallCandidate({ official: false, trusted: false }),
    },
    installBroker: installExecutionBroker(async () => ({ exitCode: 0 })),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'official-tool', version: '1.2.3' })),
  });
  await scheduler.run();
  await scheduler.retryNode('CAP-A');
  await assert.rejects(
    scheduler.retryNode('CAP-A'),
    (error) => error.code === 'CRUISE_PROVISION_ATTEMPT_LIMIT',
  );
});

test('provision retries have no hidden default attempt ceiling', async () => {
  const run = createProvisionRun({
    runId: 'retry-hist',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: {
      trusted_catalog: async () => trustedInstallCandidate({ official: false, trusted: false }),
    },
    installBroker: installExecutionBroker(async () => ({ exitCode: 0 })),
    smokeBroker: smokeVerificationBroker(async () => smokeProof({
      identity: 'official-tool',
      version: '1.2.3',
    })),
  });
  await scheduler.run();
  await scheduler.retryNode('CAP-A');
  await scheduler.retryNode('CAP-A');
  const result = await scheduler.retryNode('CAP-A');
  assert.equal(result.nodes[0].attempts.length, 4);
  assert.equal(result.nodes[0].status, 'blocked');
});

test('successful retry requeues descendants blocked only by the failed dependency', async () => {
  let failRoot = true;
  const run = createProvisionRun({
    runId: 'retry-deps',
    nodes: [node('CAP-A', 'root'), node('CAP-B', 'child', ['CAP-A'])],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    maxAttempts: 2,
    resolvers: {
      host_native: async ({ node: current }) => useCandidate({ identity: current.capability }),
    },
    smokeBroker: smokeVerificationBroker(async ({ node: current }) => {
      if (current.id === 'CAP-A' && failRoot) {
        return { ok: false, reason: 'temporarily unavailable' };
      }
      return smokeProof({ identity: current.capability });
    }),
  });
  const first = await scheduler.run();
  assert.equal(first.nodes.find(({ id }) => id === 'CAP-A').status, 'failed');
  assert.equal(first.nodes.find(({ id }) => id === 'CAP-B').status, 'blocked');
  failRoot = false;
  const final = await scheduler.retryNode('CAP-A');
  assert.equal(final.status, 'succeeded');
  assert.equal(final.nodes.find(({ id }) => id === 'CAP-B').status, 'succeeded');
});

test('state store writes private YAML atomically, round-trips, and redacts secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-provision-store-'));
  const store = new ProvisionStateStore({ root, now: fixedNow });
  const run = createProvisionRun({
    runId: 'persisted',
    nodes: [node('CAP-A', 'connector')],
    metadata: {
      authorization: 'Bearer very-secret-token',
      note: 'token=another-secret-value',
      nested: {
        accessToken: 'camel-access-secret',
        clientSecret: 'camel-client-secret',
        refreshToken: 'camel-refresh-secret',
      },
    },
    now: fixedNow,
  });
  const path = await store.saveRun(run);
  const contents = await readFile(path, 'utf8');
  assert.match(contents, /"schema_version": 1/);
  assert.doesNotMatch(contents, /very-secret-token|another-secret-value|camel-(?:access|client|refresh)-secret/);
  assert.match(contents, /\[REDACTED\]/);
  const metadata = await lstat(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o077, 0);
  const loaded = await store.loadRun('persisted', { capabilityRequest: SCHEDULER_REQUEST });
  assert.equal(loaded.metadata.authorization, '[REDACTED]');
  assert.equal(loaded.nodes[0].id, 'CAP-A');
  const registry = await readFile(join(root, '.cruise', 'internal', 'caps.yaml'), 'utf8');
  assert.match(registry, /"kind": "cruise_capability_registry"/);
});

test('persisted provision DAG authority rejects structural drift and recomputed contract bytes', async (t) => {
  const stateMutations = {
    membership(state) {
      const added = structuredClone(state.nodes[1]);
      added.id = 'CAP-C';
      added.capability = 'injected';
      added.requires = [];
      added.dependents = [];
      state.nodes.push(added);
    },
    removal(state) {
      state.nodes = state.nodes.filter(({ id }) => id !== 'CAP-B');
      state.nodes[0].dependents = [];
    },
    dependency(state) {
      state.nodes[1].requires = [];
      state.nodes[0].dependents = [];
    },
    optionality(state) {
      state.nodes[0].required_for_completion = false;
      state.nodes[0].necessity = 'optional';
    },
    fallback(state) {
      state.nodes[0].approved_fallback = { identity: 'attacker-fallback' };
    },
    capability(state) {
      state.nodes[0].capability = 'attacker-capability';
    },
  };

  for (const [name, mutate] of Object.entries(stateMutations)) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), `cruise-provision-contract-${name}-`));
      const store = new ProvisionStateStore({ root, now: fixedNow });
      const runId = `ct-${name}`;
      const run = createProvisionRun({
        runId,
        nodes: [node('CAP-A', 'source'), node('CAP-B', 'consumer', ['CAP-A'])],
        now: fixedNow,
      });
      const statePath = await store.saveRun(run);
      const state = parseProvisionYaml(await readFile(statePath, 'utf8'));
      mutate(state);
      await writeFile(statePath, stringifyProvisionYaml(state), { mode: 0o600 });
      await assert.rejects(
        store.loadRun(runId, { capabilityRequest: SCHEDULER_REQUEST }),
        /contract drift/iu,
      );
    });
  }

  for (const field of ['auth', 'permissions']) {
    await t.test(`recomputed-${field}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `cruise-provision-contract-${field}-`));
      const store = new ProvisionStateStore({ root, now: fixedNow });
      const runId = `ct-${field}`;
      const run = createProvisionRun({ runId, nodes: [node('CAP-A', 'connector')], now: fixedNow });
      const statePath = await store.saveRun(run);
      const contractPath = join(root, '.cruise', 'internal', 'provision-runs', runId, 'contract.yaml');
      const state = parseProvisionYaml(await readFile(statePath, 'utf8'));
      const contract = parseProvisionYaml(await readFile(contractPath, 'utf8'));
      if (field === 'auth') {
        contract.nodes[0].requested_execution.auth_required = true;
        state.nodes[0].requested_execution.auth_required = true;
      } else contract.request_constraints.permissions = ['attacker:write'];
      const contractBytes = stringifyProvisionYaml(contract);
      state.contract_sha256 = createHash('sha256').update(contractBytes).digest('hex');
      await writeFile(contractPath, contractBytes, { mode: 0o600 });
      await writeFile(statePath, stringifyProvisionYaml(state), { mode: 0o600 });
      await assert.rejects(
        store.loadRun(runId, { capabilityRequest: SCHEDULER_REQUEST }),
        /persisted DAG differs from the live CAPREQ-bound authority/iu,
      );
    });
  }
});

test('scheduler requires its live CAPREQ-bound DAG contract and does not expose mutable node authority', async () => {
  const tampered = createProvisionRun({
    runId: 'sched-tamper',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  tampered.nodes[0].approved_fallback = { identity: 'injected-fallback' };
  assert.throws(
    () => new ProvisionScheduler({ run: tampered }),
    /contract drift/iu,
  );

  const run = createProvisionRun({
    runId: 'sched-copy',
    nodes: [node('CAP-A', 'parser')],
    now: fixedNow,
  });
  const scheduler = new ProvisionScheduler({
    run,
    now: fixedNow,
    resolvers: { host_native: async () => useCandidate({ identity: 'parser' }) },
    smokeBroker: smokeVerificationBroker(async () => smokeProof({ identity: 'parser' })),
  });
  const exposed = scheduler.getNode('CAP-A');
  exposed.capability = 'attacker-capability';
  exposed.required_for_completion = false;
  const result = await scheduler.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nodes[0].capability, 'parser');
  assert.equal(result.nodes[0].required_for_completion, true);
});

test('state store applies Cruise exclusions and persists immutable rejected revisions privately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-provision-exclusion-'));
  const store = new ProvisionStateStore({ root, now: fixedNow });
  const run = createProvisionRun({ runId: 'exclusion-state', nodes: [node('CAP-A', 'parser')], now: fixedNow });
  await store.saveRun(run);
  const excludePath = join(root, '.cruise', 'skills', 'exclude');
  await writeFile(excludePath, '# Cruise-only exclusions\nowner/tool # revoked revision\nparser\n', { mode: 0o600 });
  assert.deepEqual(await store.loadExclusions(), ['owner/tool', 'parser']);

  const rejectedPath = await store.saveRejectedCapability({
    repository: 'owner/tool',
    commit_sha: 'a'.repeat(40),
    content_sha256: 'b'.repeat(64),
    reason: 'confirmed prompt injection',
    security_findings: ['hierarchy_override'],
    evaluated_at: '2026-07-13T00:00:00.000Z',
  });
  const rejected = await readFile(rejectedPath, 'utf8');
  assert.match(rejected, /"kind": "cruise_rejected_capabilities"/u);
  assert.match(rejected, /"commit_sha": "aaaaaaaa/u);
  const metadata = await lstat(rejectedPath);
  assert.equal(metadata.mode & 0o077, 0);

  const authPath = await store.saveAuthJobState({
    schema_version: 1,
    kind: 'cruise_auth_job_state',
    id: 'AUTH-003',
    capability_id: 'CAP-A',
    status: 'waiting_auth',
    confirmed: false,
  });
  assert.match(await readFile(authPath, 'utf8'), /"status": "waiting_auth"/u);
  assert.match(authPath, /\/auth-state\/AUTH-003\.yaml$/u);
  assert.equal((await lstat(authPath)).mode & 0o077, 0);
  const immutableAuthJob = createAuthJob({
    id: 'AUTH-006',
    capabilityId: 'CAP-A',
    serverName: 'safe-mcp.server',
  });
  const immutableAuthArtifact = await store.saveAuthJob(immutableAuthJob);
  assert.match(immutableAuthArtifact.path, /\/auth-jobs\/AUTH-006\.yaml$/u);
  assert.match(immutableAuthArtifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal((await store.saveAuthJob(immutableAuthJob)).sha256, immutableAuthArtifact.sha256);
  await assert.rejects(
    store.saveAuthJob(createAuthJob({
      id: 'AUTH-006',
      capabilityId: 'CAP-A',
      serverName: 'different-mcp.server',
    })),
    /immutable/iu,
  );
  await assert.rejects(
    store.saveAuthJobState({
      schema_version: 1,
      kind: 'cruise_auth_job_state',
      id: 'AUTH-004',
      capability_id: 'CAP-A',
      status: 'failed',
      token: 'secret-value',
    }),
    /must not contain secrets/,
  );
  await assert.rejects(
    store.saveAuthJobState({
      schema_version: 1,
      kind: 'cruise_auth_job_state',
      id: 'AUTH-005',
      capability_id: 'CAP-A',
      status: 'failed',
      diagnostics: { accessToken: 'secret-value' },
    }),
    /must not contain secrets/,
  );
});

test('sanitizer removes secret-bearing keys and values from nested adapter records', () => {
  const safe = sanitizeProvisionRecord({
    api_key: 'abc123',
    accessToken: 'camel-access',
    clientSecret: 'camel-client',
    refreshToken: 'camel-refresh',
    nested: {
      message: 'Authorization: Bearer abc.def.ghi',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart',
      ordinary: 'safe',
    },
  });
  const serialized = stringifyProvisionYaml(safe);
  assert.doesNotMatch(serialized, /abc123|abc\.def\.ghi|camel-(?:access|client|refresh)|eyJhbGci/);
  assert.equal(safe.api_key, '[REDACTED]');
  assert.equal(safe.accessToken, '[REDACTED]');
  assert.equal(safe.nested.ordinary, 'safe');
});

test('private provision workflow has no public SKILL.md entrypoint', async () => {
  const workflow = join(process.cwd(), 'internal', 'provision', 'WORKFLOW.md');
  await access(workflow);
  await assert.rejects(
    access(join(process.cwd(), 'internal', 'provision', 'SKILL.md')),
    (error) => error.code === 'ENOENT',
  );
});
