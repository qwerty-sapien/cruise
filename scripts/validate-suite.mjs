#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APPROVED_ARTIFACTS,
  isApprovePlanChoice,
  isStartCruiseChoice,
  ORIGIN_ARTIFACT,
  PLAN_ARTIFACTS,
} from './lib/goal-contract.mjs';
import {
  createOriginRecord,
  sha256Prompt,
  validateOriginRecord,
} from './lib/origin.mjs';
import {
  applyQuickPromotion,
  CLASSIFIER_OUTPUT_SCHEMA,
  normalizeClassifierOutput,
  PUBLIC_ROUTES,
  ROUTE_CONFIDENCE_THRESHOLD,
} from './lib/routing.mjs';
import {
  assertFinalTraceability,
  createTaskTrace,
  createTraceabilityRecord,
  TRACE_PREFIXES,
} from './lib/traceability.mjs';
import { WORKER_LEVEL_POLICY } from './lib/worker-policy.mjs';
import { parseYaml } from './lib/yaml-state.mjs';

export const EXPECTED_PUBLIC_SKILLS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

export const QUICK_HARD_GATE_FIXTURES = Object.freeze([
  ['public_api_change', true],
  ['abi_change', true],
  ['authentication_or_authorization', true],
  ['cryptography_secrets_or_privacy', true],
  ['data_or_serialization_migration', true],
  ['dependency_change', true],
  ['concurrency_ordering_cancellation_or_lifecycle', true],
  ['build_deployment_packaging_release_or_ci', true],
  ['unknown_indirect_callers', true],
  ['reflection_registration_or_dynamic_dispatch', true],
  ['meaningful_external_side_effects', true],
  ['insufficient_testability', true],
  ['repository_evidence_conflict', true],
  ['scope_materially_exceeded', true],
  ['root_cause_unknown', true],
  ['requires_external_research', true],
  ['material_design_choice', true],
  ['failed_quick_repairs', 2],
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/u;
const PUBLIC_COMMAND = /\$?cruise:([a-z][a-z0-9_-]*)/giu;
const PRIVATE_COMMAND = /\$?cruise:(?:_?provision|capability-provisioner)\b/iu;
const PLACEHOLDER_MARKER = /^\s*(?:[-*]\s*)?(?:TODO|TBD|FIXME)\s*(?::|\(|$)/imu;
const MACHINE_JSON_BASENAME = /^(?:origin|probe|route|state|evidence|capabilities|provision(?:-run)?)\.json$/iu;

const DESCRIPTION_CONTRACTS = Object.freeze({
  build: {
    positive: [/durable/iu, /project foundation|milestone/iu, /contract|roadmap/iu],
    negative: [/do not use/iu],
    neighbors: ['quick', 'refine', 'goal', 'debug', 'research'],
    handoff: /hand|later|execution/iu,
  },
  quick: {
    positive: [/already-defined|already.*known/iu, /bounded/iu, /low-risk/iu, /change|edit/iu],
    negative: [/do not use/iu],
    neighbors: ['refine', 'debug', 'goal'],
    handoff: /promot|use\s+(?:refine|debug|goal)/iu,
  },
  refine: {
    positive: [/finite outcome/iu, /limited unresolved|limited.*(?:scope|behavior|architecture|evidence|sequencing)/iu, /approved plan/iu, /current-thread/iu],
    negative: [/do not use/iu],
    neighbors: ['quick', 'goal'],
    handoff: /promotion|promot|neighbor|exceed/iu,
  },
  goal: {
    positive: [/consequential|long-running|cross-cutting/iu, /durab/iu, /native codex goal|goal mode/iu],
    negative: [/do not use/iu],
    neighbors: ['refine'],
    handoff: /nearest|entered only|durability|consequence/iu,
  },
  debug: {
    positive: [/diagnos/iu, /observed failure|regression|incorrect output|failing test|crash|hang|inconsistency/iu, /root cause is unknown|unknown.*root cause/iu],
    negative: [/do not use/iu],
    neighbors: ['refine', 'goal'],
    handoff: /neighbor|handoff|becomes a durable|cross-system/iu,
  },
  research: {
    positive: [/acquire|reconcile/iu, /evidence/iu, /decision brief|recommendation/iu, /without product-code edits|without.*product.*edit/iu],
    negative: [/do not use/iu],
    neighbors: ['build', 'refine', 'goal'],
    handoff: /hand implementation|after the recommendation|handoff/iu,
  },
});

function portable(path) {
  return path.split(sep).join('/');
}

function walkFiles(root, { extensions = null } = {}) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (!extensions || extensions.has(extname(entry.name)))) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function frontmatter(markdown, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) throw new Error(`${path} must begin with YAML frontmatter`);
  const record = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!pair) throw new Error(`${path} contains unsupported multiline frontmatter`);
    let value = pair[2];
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/gu, "'");
    record[pair[1]] = value;
  }
  return record;
}

function classifier(overrides = {}) {
  return {
    route: 'quick',
    recommended_level: 2,
    confidence: 0.95,
    ambiguity: 'low',
    semantic_risk: 'low',
    estimated_files: 1,
    estimated_diff_lines: 3,
    public_api_change: false,
    abi_change: false,
    data_migration: false,
    security_sensitive: false,
    concurrency_sensitive: false,
    build_or_release_change: false,
    unknown_indirect_callers: false,
    requires_external_research: false,
    reasons: [],
    ...overrides,
  };
}

function markdownLinkTargets(source) {
  const targets = [];
  const expression = /(?<!!)\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of source.matchAll(expression)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (/^(?:https?:|mailto:|data:)/iu.test(target) || target.startsWith('#')) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (target) targets.push(decodeURIComponent(target));
  }
  return targets;
}

function publicSurfaceFiles(root) {
  const paths = [
    join(root, 'README.md'),
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, 'scripts', 'cruise.mjs'),
  ];
  for (const skill of EXPECTED_PUBLIC_SKILLS) {
    const directory = join(root, 'skills', skill);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    paths.push(...walkFiles(directory, { extensions: new Set(['.md', '.yaml', '.yml']) }));
  }
  return [...new Set(paths)];
}

function assertNoPublicCommandLeak(root) {
  for (const path of publicSurfaceFiles(root)) {
    const source = readFileSync(path, 'utf8');
    if (PRIVATE_COMMAND.test(source)) {
      throw new Error(`private capability is presented as a public command in ${portable(relative(root, path))}`);
    }
    for (const match of source.matchAll(PUBLIC_COMMAND)) {
      if (!EXPECTED_PUBLIC_SKILLS.includes(match[1].toLowerCase())) {
        throw new Error(`dead or unsupported public command ${match[0]} in ${portable(relative(root, path))}`);
      }
    }
  }
}

function assertDescriptions(skillRecords) {
  for (const skill of EXPECTED_PUBLIC_SKILLS) {
    const description = skillRecords.get(skill).description;
    const split = description.search(/\bDo not use\b/iu);
    if (split < 1) throw new Error(`${skill} description must state explicit negative activation conditions`);
    const positive = description.slice(0, split);
    const negative = description.slice(split);
    const contract = DESCRIPTION_CONTRACTS[skill];
    for (const pattern of contract.positive) {
      if (!pattern.test(positive)) throw new Error(`${skill} description lacks defining positive intent: ${pattern}`);
    }
    for (const pattern of contract.negative) {
      if (!pattern.test(negative)) throw new Error(`${skill} description lacks negative admission language`);
    }
    for (const neighbor of contract.neighbors) {
      if (!new RegExp(`\\b${neighbor}\\b`, 'iu').test(negative)) {
        throw new Error(`${skill} description does not name neighboring route ${neighbor}`);
      }
    }
    if (!contract.handoff.test(negative)) {
      throw new Error(`${skill} description lacks an exact promotion or handoff rule`);
    }
  }
}

function assertSkillMetadata(root, skillsRoot) {
  const discovered = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...EXPECTED_PUBLIC_SKILLS].sort((left, right) => left.localeCompare(right, 'en'));
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
    throw new Error(`public skill set must be exactly ${expected.join(', ')}; found ${discovered.join(', ') || '<none>'}`);
  }

  const records = new Map();
  for (const skill of EXPECTED_PUBLIC_SKILLS) {
    const skillPath = join(skillsRoot, skill, 'SKILL.md');
    if (!statSync(skillPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${portable(relative(root, skillPath))} is missing`);
    }
    const metadata = frontmatter(readFileSync(skillPath, 'utf8'), portable(relative(root, skillPath)));
    if (metadata.name !== skill) throw new Error(`${skillPath} frontmatter name must equal ${skill}`);
    if (typeof metadata.description !== 'string' || metadata.description.length < 80) {
      throw new Error(`${skillPath} needs a substantive mutually-exclusive description`);
    }
    records.set(skill, metadata);

    const agentPath = join(skillsRoot, skill, 'agents', 'openai.yaml');
    const agent = parseYaml(readFileSync(agentPath, 'utf8'));
    if (!agent?.interface?.default_prompt?.includes(`$cruise:${skill}`)) {
      throw new Error(`${portable(relative(root, agentPath))} must invoke only its public skill`);
    }
    if (agent?.policy?.allow_implicit_invocation !== false) {
      throw new Error(`${portable(relative(root, agentPath))} must keep implicit invocation disabled`);
    }
    for (const match of agent.interface.default_prompt.matchAll(PUBLIC_COMMAND)) {
      if (match[1] !== skill) throw new Error(`${skill} default prompt routes to competing skill ${match[1]}`);
    }
  }
  assertDescriptions(records);
}

function assertManifest(root, manifest) {
  if (manifest.name !== 'cruise') throw new Error('plugin manifest name must remain cruise');
  if (manifest.skills !== './skills/') throw new Error('plugin manifest must register only ./skills/');
  const forbiddenKeys = new Set([
    'hiddenskills',
    'privateskills',
    'internalskills',
    '_provision',
    'provisioner',
  ]);
  const visit = (value, path = 'plugin') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) throw new Error(`unsupported hidden-skill manifest field ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(manifest);
  if (!Array.isArray(manifest.interface?.defaultPrompt) || manifest.interface.defaultPrompt.length === 0) {
    throw new Error('plugin interface.defaultPrompt must be a non-empty array');
  }
}

function assertLinks(root) {
  const paths = [join(root, 'README.md')];
  for (const directory of ['skills', 'internal']) {
    paths.push(...walkFiles(join(root, directory), { extensions: new Set(['.md']) }));
  }
  for (const path of paths) {
    for (const target of markdownLinkTargets(readFileSync(path, 'utf8'))) {
      const absolute = isAbsolute(target) ? target : resolve(dirname(path), target);
      const relativeTarget = portable(relative(root, absolute));
      if (relativeTarget === '..' || relativeTarget.startsWith('../')) {
        throw new Error(`local documentation link escapes plugin root: ${portable(relative(root, path))} -> ${target}`);
      }
      if (!statSync(absolute, { throwIfNoEntry: false })) {
        throw new Error(`broken local link: ${portable(relative(root, path))} -> ${target}`);
      }
    }
  }
}

function assertNoPlaceholders(root) {
  const paths = [
    join(root, 'README.md'),
    join(root, '.codex-plugin', 'plugin.json'),
    ...walkFiles(join(root, 'scripts'), { extensions: new Set(['.mjs']) }),
    ...walkFiles(join(root, 'skills'), { extensions: new Set(['.md', '.yaml', '.yml']) }),
    ...walkFiles(join(root, 'internal'), { extensions: new Set(['.md', '.yaml', '.yml']) }),
  ];
  for (const path of paths) {
    if (PLACEHOLDER_MARKER.test(readFileSync(path, 'utf8'))) {
      throw new Error(`unfinished TODO/TBD/FIXME marker in ${portable(relative(root, path))}`);
    }
  }
}

function assertYamlStateOnly(root) {
  for (const path of walkFiles(root)) {
    const rel = portable(relative(root, path));
    if ((rel.startsWith('.cruise/') || MACHINE_JSON_BASENAME.test(path.split(sep).at(-1))) && extname(path) === '.json') {
      throw new Error(`Cruise machine-state record must be YAML, not JSON: ${rel}`);
    }
  }
  const stateLiteral = /\.cruise\/(?:runs|goal|internal)\/[A-Za-z0-9_./<>-]*(?:origin|probe|route|state|evidence|capabilities|provision-runs?)[A-Za-z0-9_./<>-]*\.json\b/iu;
  for (const directory of ['scripts', 'skills', 'internal']) {
    for (const path of walkFiles(join(root, directory), { extensions: new Set(['.mjs', '.md', '.yaml', '.yml']) })) {
      if (stateLiteral.test(readFileSync(path, 'utf8'))) {
        throw new Error(`JSON Cruise state path is documented or emitted by ${portable(relative(root, path))}`);
      }
    }
  }
}

function assertCheckedInYamlParses(root) {
  for (const directory of ['skills', 'internal', 'evals']) {
    for (const path of walkFiles(join(root, directory), { extensions: new Set(['.yaml', '.yml']) })) {
      try {
        parseYaml(readFileSync(path, 'utf8'));
      } catch (error) {
        throw new Error(`${portable(relative(root, path))} is not accepted by Cruise YAML: ${error.message}`);
      }
    }
  }
}

function assertSchemaContracts(root) {
  if (JSON.stringify(PUBLIC_ROUTES) !== JSON.stringify(EXPECTED_PUBLIC_SKILLS)) {
    throw new Error(`routing public routes differ from the six public skills: ${PUBLIC_ROUTES.join(', ')}`);
  }
  if (ROUTE_CONFIDENCE_THRESHOLD !== 0.85) throw new Error('routing confidence threshold must be 0.85');
  if (!CLASSIFIER_OUTPUT_SCHEMA?.properties?.route?.enum) throw new Error('route classifier schema is absent');
  if (CLASSIFIER_OUTPUT_SCHEMA?.properties?.recommended_level?.minimum !== 2 || CLASSIFIER_OUTPUT_SCHEMA?.properties?.recommended_level?.maximum !== 7) {
    throw new Error('route classifier recommended_level must be bounded from 2 through 7');
  }
  const expectedWorkers = {
    1: { agent_type: 'cruise_l1', alias: 'luna-M', tier: 'luna', reasoning_effort: 'medium' },
    2: { agent_type: 'cruise_l2', alias: 'terra-M', tier: 'terra', reasoning_effort: 'medium' },
    3: { agent_type: 'cruise_l3', alias: 'terra-H', tier: 'terra', reasoning_effort: 'high' },
    4: { agent_type: 'cruise_l4', alias: 'terra-X', tier: 'terra', reasoning_effort: 'xhigh' },
    5: { agent_type: 'cruise_l5', alias: 'sol-H', tier: 'sol', reasoning_effort: 'high' },
    6: { agent_type: 'cruise_l6', alias: 'sol-X', tier: 'sol', reasoning_effort: 'xhigh' },
    7: { agent_type: 'cruise_l7', alias: 'sol-U', tier: 'sol', reasoning_effort: 'ultra' },
  };
  if (JSON.stringify(WORKER_LEVEL_POLICY) !== JSON.stringify(expectedWorkers)) {
    throw new Error('root-managed worker levels must map exactly to all seven managed Codex agents');
  }
  normalizeClassifierOutput(classifier());

  const rawPrompt = 'Preserve these exact bytes.  \n';
  const origin = createOriginRecord({
    rawPrompt,
    selectedSkill: 'quick',
    repositoryBaseline: {
      root: realpathSync(root),
      head: null,
      branch: null,
      dirty_state_digest: 'a'.repeat(64),
      instruction_files: [],
    },
    deterministicProbeDigest: 'b'.repeat(64),
    initialClassifier: 'Luna Medium',
    selectedRoute: 'quick',
    confidence: 0.92,
  });
  validateOriginRecord(origin);
  if (!SHA256.test(origin.origin.prompt_sha256) || origin.origin.prompt_sha256 !== sha256Prompt(rawPrompt)) {
    throw new Error('Origin Record does not preserve the raw prompt SHA-256');
  }
  const tampered = structuredClone(origin);
  tampered.origin.raw_prompt += 'changed';
  let rejected = false;
  try {
    validateOriginRecord(tampered);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Origin Record schema accepts a raw-prompt/hash mismatch');

  const task = createTaskTrace({
    taskId: 'T-01',
    satisfies: ['R-01', 'AC-01'],
    preserves: ['G-01'],
    verification: ['E-01'],
  });
  const trace = createTraceabilityRecord({
    goal_clauses: [{ id: 'G-01' }],
    requirements: [{ id: 'R-01' }],
    acceptance_criteria: [{ id: 'AC-01' }],
    decisions: [{ id: 'D-01' }],
    tasks: [task],
    evidence: [{ id: 'E-01' }],
    findings: [{ id: 'F-01' }],
    hypotheses: [{ id: 'H-01' }],
  });
  assertFinalTraceability(trace);
  if (TRACE_PREFIXES.join('/') !== 'G/R/AC/D/T/E/F/H') throw new Error('stable traceability prefixes changed');
}

function assertQuickGates() {
  const normalized = normalizeClassifierOutput(classifier());
  for (const [signal, value] of QUICK_HARD_GATE_FIXTURES) {
    const admission = applyQuickPromotion({
      selectedSkill: 'quick',
      proposedRoute: 'quick',
      probe: { signals: { [signal]: value } },
      classifier: normalized,
    });
    if (admission.route === 'quick' || !admission.promotion_reasons.includes(signal)) {
      throw new Error(`Quick hard gate ${signal} did not promote before editing`);
    }
  }
  const noSignal = applyQuickPromotion({
    selectedSkill: 'quick',
    proposedRoute: 'quick',
    probe: { signals: {} },
    classifier: normalizeClassifierOutput(classifier({ estimated_files: 10_000, estimated_diff_lines: 1_000_000 })),
  });
  if (noSignal.route !== 'quick') throw new Error('file count alone must not force Quick promotion');
}

function assertGoalContract(root) {
  if (
    !isApprovePlanChoice('Approve Plan') ||
    isApprovePlanChoice('approve plan') ||
    isApprovePlanChoice('Approve Plan!') ||
    isApprovePlanChoice(' Approve Plan') ||
    isApprovePlanChoice('Approve Plan\n')
  ) {
    throw new Error('Goal Plan approval must accept only the exact case-sensitive Approve Plan label');
  }
  if (
    !isStartCruiseChoice('Start Cruise') ||
    isStartCruiseChoice('start cruise') ||
    isStartCruiseChoice('Start Cruise!') ||
    isStartCruiseChoice(' Start Cruise') ||
    isStartCruiseChoice('Start Cruise\n')
  ) {
    throw new Error('Goal activation must accept only the exact case-sensitive Start Cruise label');
  }
  if (ORIGIN_ARTIFACT !== '.cruise/goal/ORIGIN.yaml' || !PLAN_ARTIFACTS.includes(ORIGIN_ARTIFACT) || !APPROVED_ARTIFACTS.includes(ORIGIN_ARTIFACT)) {
    throw new Error('Goal approval snapshots must lock the immutable ORIGIN.yaml bytes');
  }
  const source = readFileSync(join(root, 'scripts', 'lib', 'goal-contract.mjs'), 'utf8');
  for (const token of ["method: 'thread/goal/get'", "method: 'thread/goal/set'", 'assertCloseoutInactive']) {
    if (!source.includes(token)) throw new Error(`Goal native activation contract is missing ${token}`);
  }
  const session = readFileSync(join(root, 'scripts', 'lib', 'session.mjs'), 'utf8');
  if (!session.includes("'thread/goal/get'") || !session.includes("'thread/goal/set'")) {
    throw new Error('terminal client must use native thread/goal/get and thread/goal/set');
  }
  if (/spawn(?:Sync)?\s*\([^\n]*['"][^'"]*\/goal/iu.test(source + session)) {
    throw new Error('Goal activation must not simulate /goal through a shell process');
  }
}

function assertPlanningOnlySkills(root) {
  const build = readFileSync(join(root, 'skills', 'build', 'SKILL.md'), 'utf8');
  const research = readFileSync(join(root, 'skills', 'research', 'SKILL.md'), 'utf8');
  if (!/must not modify product source|never implements product code|does not implement product code/iu.test(build)) {
    throw new Error('Build must explicitly prohibit product-code writes');
  }
  if (!/must not modify product code|must not modify product code, application dependencies/iu.test(research)) {
    throw new Error('Research must explicitly prohibit product-code writes');
  }
  for (const [skill, source] of [['build', build], ['research', research]]) {
    if (/\b(?:apply_patch|git\s+commit|sed\s+-i|writeFileSync\s*\()\b/iu.test(source)) {
      throw new Error(`${skill} workflow contains a product-write command`);
    }
  }
}

function assertPrivateProvisioner(root) {
  const directory = join(root, 'internal', 'provision');
  if (statSync(join(directory, 'SKILL.md'), { throwIfNoEntry: false })) {
    throw new Error('private provisioner must not expose a SKILL.md');
  }
  const policy = parseYaml(readFileSync(join(directory, 'policy.yaml'), 'utf8'));
  const schema = parseYaml(readFileSync(join(directory, 'schema.yaml'), 'utf8'));
  if (policy?.visibility !== 'private_internal_workflow' || policy?.public_surface?.exposed !== false) {
    throw new Error('private provision policy visibility is not fail-closed');
  }
  if (JSON.stringify(policy.public_surface.public_skills_allowed_to_request) !== JSON.stringify(EXPECTED_PUBLIC_SKILLS) ||
      policy.public_surface.recursive_public_skill_invocation !== 'forbidden') {
    throw new Error('private provision requesters or recursion boundary differs from the six public skills');
  }
  if (policy?.default_decision?.action !== 'no_provisioning' ||
      policy?.default_decision?.reason !== 'current_capabilities_sufficient') {
    throw new Error('private provision default must remain no_provisioning/current_capabilities_sufficient');
  }
  if (policy?.sandboxes?.attestation?.opaque_process_local_token_required !== true ||
      policy?.sandboxes?.current_host?.direct_external_activation_allowed !== false ||
      policy?.authentication?.tmux?.current_host_runner_confirmed !== false) {
    throw new Error('private provision sandbox/auth host claims must remain attested and fail-closed');
  }
  const dimensions = policy?.fit?.dimensions ?? {};
  const fitMaximum = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  if (fitMaximum !== 100 || policy.fit.normal_gate.aggregate_minimum !== 85 ||
      policy.fit.normal_gate.confidence_minimum !== 0.85 ||
      policy.fit.high_consequence_gate.aggregate_minimum !== 90 ||
      policy.fit.high_consequence_gate.confidence_minimum !== 0.9) {
    throw new Error('private provision 100-point fit gates are inconsistent');
  }
  for (const status of ['excluded', 'quarantined', 'waiting_auth']) {
    if (!schema.node_statuses.includes(status)) throw new Error(`private provision schema omits ${status}`);
  }
  const implementation = readFileSync(join(root, 'scripts', 'lib', 'provision-policy.mjs'), 'utf8');
  const executor = readFileSync(join(root, 'scripts', 'lib', 'provision.mjs'), 'utf8');
  for (const token of [
    'ELIGIBLE_EVALUATIONS',
    'inspectUntrustedCandidate',
    'verifyInstructionAnalysisSandbox',
    'verifyExecutionSandbox',
    'createHostSandboxAttestation',
    'TRUSTED_AUTH_RUNNERS',
    'createTrustedAuthRunnerAttestation',
    'extractLearningOnly',
    'createLocalSpinRecord',
    'validateLocalSpinOnDisk',
    'createAuthJob',
    'runStructuredAuthJob',
    'reconcileCapabilityLoss',
    'enforceProvisionBoundary',
  ]) {
    if (!implementation.includes(token)) throw new Error(`private provision implementation omits ${token}`);
  }
  for (const unsafe of ['candidate.install ??', 'candidate.smokeTest ??', 'candidate.rollback ??', 'auth_action']) {
    if (executor.includes(unsafe)) throw new Error(`private provision executor retains unsafe candidate control: ${unsafe}`);
  }
  for (const skill of EXPECTED_PUBLIC_SKILLS) {
    const source = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
    if (!/private (?:capability|provision)/iu.test(source) || !/recurs/iu.test(source)) {
      throw new Error(`${skill} lacks the private capability and recursion boundary`);
    }
  }
}

export function validateSuite({ root = ROOT } = {}) {
  const canonicalRoot = realpathSync(resolve(root));
  const errors = [];
  const checks = [];
  const check = (name, action) => {
    try {
      action();
      checks.push({ name, status: 'PASS' });
    } catch (error) {
      checks.push({ name, status: 'BLOCK', message: error.message });
      errors.push(`${name}: ${error.message}`);
    }
  };

  let manifest = null;
  check('plugin manifest', () => {
    manifest = JSON.parse(readFileSync(join(canonicalRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    assertManifest(canonicalRoot, manifest);
  });
  check('exactly six public skills and exclusive metadata', () => assertSkillMetadata(canonicalRoot, join(canonicalRoot, 'skills')));
  check('private capability absent from public commands', () => assertNoPublicCommandLeak(canonicalRoot));
  check('local documentation links resolve', () => assertLinks(canonicalRoot));
  check('no unfinished public/runtime placeholders', () => assertNoPlaceholders(canonicalRoot));
  check('Cruise machine state is YAML', () => assertYamlStateOnly(canonicalRoot));
  check('all checked-in YAML parses', () => assertCheckedInYamlParses(canonicalRoot));
  check('Origin route and traceability schemas', () => assertSchemaContracts(canonicalRoot));
  check('Quick hard promotion gates', () => assertQuickGates());
  check('Goal exact labels locks and native state', () => assertGoalContract(canonicalRoot));
  check('Build and Research write boundaries', () => assertPlanningOnlySkills(canonicalRoot));
  check('private provision policy and enforcement boundary', () => assertPrivateProvisioner(canonicalRoot));

  return Object.freeze({
    ok: errors.length === 0,
    root: canonicalRoot,
    public_skills: [...EXPECTED_PUBLIC_SKILLS],
    checks,
    errors,
  });
}

export function formatValidationResult(result) {
  const lines = result.checks.map((check) =>
    `${check.status.padEnd(5)} ${check.name}${check.message ? ` — ${check.message}` : ''}`,
  );
  lines.push(result.ok
    ? `PASS  Cruise suite validation (${result.public_skills.length} public skills)`
    : `BLOCK Cruise suite validation (${result.errors.length} failing check${result.errors.length === 1 ? '' : 's'})`);
  return `${lines.join('\n')}\n`;
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : ROOT;
  if (rootIndex >= 0 && !root) {
    process.stderr.write('Usage: node scripts/validate-suite.mjs [--root PATH] [--json]\n');
    process.exitCode = 2;
  } else {
    const result = validateSuite({ root });
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatValidationResult(result));
    if (!result.ok) process.exitCode = 1;
  }
}
