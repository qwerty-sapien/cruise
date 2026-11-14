import { resolveApprovalsReviewer, nativeReviewerInstructions } from './simple-worker.mjs';
import { INDEPENDENT_RELEASE_INSTRUCTIONS } from './release-policy.mjs';
import { COLLABORATIVE_GIT_SYNC_INSTRUCTIONS } from './git-sync-policy.mjs';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_STALL,
  flightPlanTemplate,
  inspectFlightPlan,
} from './flight-plan.mjs';
import {
  captureFlightAssuranceContext,
  evaluateFlightAssurance,
} from './assurance.mjs';
import {
  atomicWriteText,
  captureWorkspaceFingerprint,
  ensureCruiseScratch,
  extractFailureSignature,
  GoalSupervisor,
  writeCruiseScratchJson,
  writeSupervisorState,
} from './supervisor.mjs';
import { writeRuntimeJson } from './runtime-state.mjs';
import { UsageMeter } from './usage-meter.mjs';
import { CompactionController } from './compaction-controller.mjs';
import { readContinuationContext } from './context-capsule.mjs';
import {
  AUTHORIZATION_ACTION,
  AUTHORIZATION_POLICY_INSTRUCTIONS,
  automaticDelegationAuthorization,
  BOUNDED_WORKER_PROCEED_ANSWER,
  classifyCruiseAuthorization,
  DECOMPOSE_SCOPE_ANSWER,
  CRUISE_INTEGRITY_DRIFT_ANSWER,
  CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS,
  MINIMUM_INSPECTION_ANSWER,
  PREAUTHORIZED_PROCEED_ANSWER,
  SENSITIVE_PATH_SKIP_ANSWER,
  WHOLE_TABLE_NO_READ_ANSWER,
  ROUTINE_DELEGATION_ANSWER,
  isSpeculativeWorkerAuthorizationPause,
  isCruiseIntegrityDriftAuthorizationPause,
  WORKER_AUTHORIZATION_RECOVERY_INSTRUCTIONS,
} from './authorization-policy.mjs';
import { skillTriggerInstructions } from './skill-trigger-policy.mjs';
import { selectRootRequest } from './root-policy.mjs';
import {
  codexHome,
  codexSessionsDirectory,
  locateRollout,
} from './trace-locator.mjs';

const TERMINAL_GOAL_STATUSES = new Set([
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]);

const ROUTINE_GOAL_ADVANCE_QUESTION = /^(?:(?:[ptm]-?\d+|phase\s*\d+|subtask\s*\d+|task\s*\d+|micro[-\s]?goal)\s*)?(?:(?:has\s+)?passed(?:\s+its)?(?:\s+focused)?(?:\s+readiness)?\s+checks|is\s+ready|is\s+complete|completed)\.?\s*(?:what\s+next|continue|proceed|advance)?\??$/iu;
const ROUTINE_GOAL_ADVANCE_OPTION = /^\s*(?:approve\s+(?:[ptm]-?\d+|phase\s*\d+|subtask\s*\d+|task\s*\d+|micro[-\s]?goal)(?:\s+only)?|(?:proceed|continue|advance|resume|start|implement|execute)\s+(?:the\s+)?(?:next\s+)?(?:ready\s+)?(?:[ptm]-?\d+|phase\s*\d+|subtask\s*\d+|task\s*\d+|micro[-\s]?goal))\b/iu;
const PREPARATION_ONLY_GOAL_PROMPT = /\b(?:only\s+(?:plan|research|prepare|design)|(?:plan|research|prepare|design)\s+only|do\s+not\s+(?:implement|edit|write(?:\s+code)?|execute)|do\s+not\s+make\s+(?:code\s+)?changes|without\s+implementation)\b/iu;
const GOAL_AUTHORIZATION_CONTEXT = /\b(?:plan(?:\s+and\s+goal)?|goal|cruise|contract|phase|micro[-\s]?goal|next\s+(?:step|phase|micro[-\s]?goal))\b/iu;
const GOAL_AUTHORIZATION_OPTION = /^\s*(?:allow|approve(?:\s+(?:both|the\s+(?:plan|goal|contract)|[a-z]+-?\d+\s+contract))?|authorize|continue|delegate|execute|implement|inspect|launch|proceed|read|run|send|start\s+cruise)\b/iu;
const HOST_RISK_GOAL_AUTHORIZATION = /\b(?:payment|purchase|publish|release|sudo)\b|\bdeploy(?:ment)?\s+to\s+production\b|\bproduction\s+(?:database|migration|sql)\b|\bauthorize-production\b|\bforce[- ]push\b/iu;
const MATERIAL_GOAL_DECISION = /\b(?:not\s+requested|out(?:side)?\s+(?:the\s+)?scope|scope\s+(?:change|expansion)|which\s+(?:option|approach)|user\s+preference)\b/iu;

const AUTONOMOUS_GOAL_INSTRUCTIONS = [
  'The user explicitly invoked Cruise Goal, which authorizes autonomous end-to-end progress within the normal Codex workspace and permission boundaries.',
  AUTHORIZATION_POLICY_INSTRUCTIONS,
  'Use the first read-only Plan turn only to inspect the repository, resolve the outcome, touchpoints, non-goals, invariants, acceptance commands, and stall tuning, and form a strongly aligned plan for the first ready micro-goal. Unless the user explicitly requested planning or research only, that plan is not an endpoint: the following native Goal turn must immediately implement it and write the advisory .cruise/FLIGHT.md as its first execution act.',
  'Flight scope.touchpoints and gate surfaces describe owned product-relative paths. Record authorized external read dependencies separately in the Flight body and verification commands; do not put absolute or parent-relative read paths into non-Git product fingerprint surfaces. Correct a mistaken scope declaration as routine reconciliation while preserving the actual acceptance criteria and read authorization.',
  'For every micro-goal, use the compact Flight digest and unresolved-gate summary; reopen detailed receipts only for stale surfaces. Realign before work outside touchpoints or inside non-goals; re-verify affected invariants; implement the next ready slice; run focused verification; remediate in-scope failures; then continue.',
  'When changed behavior has meaningful concurrency, lifecycle, migration, public-contract, security, integration, or edge-case risk, use available independent reviewers or a bounded agent swarm to try to break it. Give them non-overlapping probes, reproduce credible findings, and refine before advancing. Skip this for simple low-risk work and never claim independent coverage that did not run.',
  'Do not ask the user to approve a phase, checkpoint, plan handoff, or ordinary next step. Ask only for a material product decision that repository evidence cannot resolve, a scope or safety expansion, authentication or secret entry, or a host-required external or destructive approval.',
  'Do not mark the Goal paused or blocked merely because a phase ended or because a fresh continuation is needed. Cruise starts another turn automatically while the Goal remains active.',
  'Keep the native Goal active until every requested acceptance and verification criterion passes, then set the flight plan and Goal to complete. Set both to blocked only for a concrete unresolved blocker, stating the blocker and evidence needed to resume in the flight-plan body. The flight plan grants and gates nothing; native permissions remain authoritative.',
].join(' ');

const GOAL_BOOTSTRAP_INSTRUCTIONS = [
  'Begin with this sole read-only Plan-mode bootstrap, not a plan-only handoff.',
  'Inspect the codebase, resolve the advisory flight plan fields, and state a compact plan for the first ready, in-scope micro-goal. This turn cannot write .cruise/FLIGHT.md.',
  'Do not implement in this Plan turn. Unless the request explicitly limits work to planning or research, switch to Default mode immediately afterward and implement and verify this micro-goal.',
].join(' ');

const GOAL_CONTINUATION_INSTRUCTIONS = [
  'Continue the active Cruise Goal now; this is execution, not a request for a new plan review.',
  'Use only the injected compact handoff, next work item, quota state, and unresolved assurance; do not restate the original request, full Flight, or prior plan.',
  'Immediately implement the next ready micro-goal and run focused verification.',
  'Rerun only invalidated checks, use bounded independent breakage probes when warranted, and continue until the Flight and Goal are truthfully complete or both report a concrete material blocker.',
  'Routine micro-goal progression is already authorized; do not ask the user for a phase or plan approval.',
].join(' ');

const MAX_TURN_AGENT_TEXT = 64 * 1024;
const MAX_HANDOFF_BYTES = 4 * 1024;
const CONTEXT_STATE_FILES = Object.freeze([
  'LAST-RUN.json',
  'USAGE.json',
  'HANDOFF.md',
  'BUDGET-PAUSE.json',
  'artifacts/',
]);
// Goal metadata is not evidence of inference. Bound idle startup by default;
// an observed turn uses the normal transport/progress watchdog instead.
export const DEFAULT_FIRST_TURN_DEADLINE_MS = 30_000;
export function resolveFirstTurnDeadlineMs(value = process.env.CRUISE_GOAL_BOOTSTRAP_TIMEOUT_MS) {
  if (value === undefined || value === null) return DEFAULT_FIRST_TURN_DEADLINE_MS;
  if (value === 'off') return 0;
  const milliseconds = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) {
    throw new TypeError('Goal bootstrap timeout must be an integer from 0 through 2147483647 milliseconds (0 disables it).');
  }
  return milliseconds;
}
const DEFAULT_FIRST_TURN_CLEANUP_DEADLINE_MS = 2_000;

function formatDuration(milliseconds) {
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (Buffer.byteLength(text) <= maximumBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maximumBytes - 3) end -= 1;
  return `${text.slice(0, end)}...`;
}

function realignmentInstructions(reason) {
  return [
    `Cruise supervision observed: ${reason}.`,
    'Repeating the same approach is not authorized progress.',
    'Change approach now: run the smallest discriminating experiment that produces new workspace evidence, or set the Goal to blocked and state the concrete blocker and evidence needed to resume.',
  ].join(' ');
}

function finalExperimentInstructions(reason) {
  return [
    `Cruise supervision still observes no progress after realignment: ${reason}.`,
    'Produce new workspace evidence this turn or set the Goal to blocked yourself with a concrete blocker report.',
    'This is the last supervised continuation before Cruise pauses the Goal with a stall report.',
  ].join(' ');
}

function correctiveFlightInstructions(reason) {
  return [
    `Cruise Goal supervision is degraded because .cruise/FLIGHT.md is invalid: ${reason}.`,
    'Rewrite .cruise/FLIGHT.md so it parses, preserving the intent already written there. Use this full canonical template:',
    flightPlanTemplate(),
  ].join('\n\n');
}

function assuranceCorrectionInstructions(assessment) {
  const unresolved = assessment.reasons.length
    ? assessment.reasons.map((reason) => `- ${reason}`).join('\n')
    : '- completion is not evidence-attested';
  return [
    'Cruise rejected the attempted completion because the Flight v2 assurance contract is not closed.',
    `Expected context_fingerprint: ${assessment.contextFingerprint ?? 'unavailable'}`,
    `Unresolved assurance:\n${unresolved}`,
    'Keep the Goal active. Reconcile the quality profiles and required dimensions with the original request, run each oracle through ordinary host tools and permissions, then record truthful fresh evidence. A hook never executes oracle text.',
    'Set a gate to not_applicable only with a fresh rationale. A waiver requires an explicit user decision. Do not weaken or delete a gate merely to obtain completion.',
  ].join('\n\n');
}

function stallReport(verdict, summary, { pauseError = null } = {}) {
  const fingerprints = summary.fingerprints.length ? summary.fingerprints.join(', ') : 'unavailable';
  const signatures = summary.failureSignatures.length ? summary.failureSignatures.join(', ') : 'none';
  const interventions = summary.interventions.map(({ level, reason }) => `${level}: ${reason}`).join('\n  - ');
  return [
    `Cruise Goal stalled after ${summary.turnsObserved} supervised continuation turns.`,
    `Observed: ${verdict.reason}.`,
    `Workspace fingerprints involved: ${fingerprints}.`,
    `Failure signatures involved: ${signatures}.`,
    `Interventions already attempted:\n  - ${interventions || 'realignment and final experiment'}`,
    pauseError
      ? `The native Goal pause could not be confirmed: ${String(pauseError.message ?? pauseError).replace(/\s+/gu, ' ').trim()}. No work was silently killed.`
      : 'The native Goal is paused; no work was silently killed.',
    'Suggested next actions: inspect the last failure and diff, edit .cruise/FLIGHT.md stall tuning if warranted, provide missing evidence or a material decision, then resume the Goal.',
  ].join('\n');
}


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectionValue(selection) {
  return selection?.value ?? selection?.label ?? null;
}

function optionValue(option) {
  if (typeof option === 'string') return option;
  return option?.value ?? option?.label ?? null;
}

function optionLabel(option) {
  if (typeof option === 'string') return option;
  return option?.label ?? option?.value ?? '';
}

function isPreparationOnlyGoalPrompt(prompt) {
  return PREPARATION_ONLY_GOAL_PROMPT.test(String(prompt ?? ''));
}

/**
 * Phase gates are an implementation detail of a Goal, not a fresh user
 * authorization.  Accept only an unmistakably routine structured gate; all
 * material choices and every free-text question still go to the user.
 */
export function automaticRoutineGoalAdvance(params = {}) {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) return null;

  const answers = {};
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!ROUTINE_GOAL_ADVANCE_QUESTION.test(String(question?.question ?? '').trim())) return null;
    const choice = options.find((option) => ROUTINE_GOAL_ADVANCE_OPTION.test(optionLabel(option)));
    const value = optionValue(choice);
    if (typeof question?.id !== 'string' || question.id.length === 0 || value === null) return null;
    answers[question.id] = { answers: [String(value)] };
  }
  return { answers };
}

/**
 * An explicit Cruise Goal invocation authorizes an in-scope plan, Goal, or
 * contract transition. The host still asks about actual external, destructive,
 * or otherwise high-risk effects through its normal approval protocol.
 */
export function automaticGoalAuthorization(params = {}, { nativeApprovalDenied = false } = {}) {
  if (nativeApprovalDenied) return null;
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) return null;

  const answers = {};
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const visible = [
      question?.header ?? '',
      question?.question ?? '',
      ...options.flatMap((option) => typeof option === 'string'
        ? [option] : [option?.label, option?.description, option?.value]),
    ].filter((value) => typeof value === 'string').join('\n');
    const boundary = classifyCruiseAuthorization(visible);
    if (
      typeof question?.id !== 'string' ||
      question.id.length === 0 ||
      MATERIAL_GOAL_DECISION.test(visible) ||
      boundary.action === AUTHORIZATION_ACTION.requestUser ||
      boundary.reason === 'native-permission-denied' ||
      (
        boundary.action === AUTHORIZATION_ACTION.nativePermissions &&
        (
          !GOAL_AUTHORIZATION_CONTEXT.test(visible) ||
          HOST_RISK_GOAL_AUTHORIZATION.test(visible)
        )
      )
    ) {
      return null;
    }
    if (boundary.action === AUTHORIZATION_ACTION.inspectMinimum) {
      answers[question.id] = { answers: [MINIMUM_INSPECTION_ANSWER] };
      continue;
    }
    if (boundary.action === AUTHORIZATION_ACTION.decompose) {
      answers[question.id] = { answers: [DECOMPOSE_SCOPE_ANSWER] };
      continue;
    }
    if (boundary.action === AUTHORIZATION_ACTION.respectNoRead) {
      answers[question.id] = { answers: [WHOLE_TABLE_NO_READ_ANSWER] };
      continue;
    }
    if (boundary.action === AUTHORIZATION_ACTION.skipSensitive) {
      answers[question.id] = { answers: [SENSITIVE_PATH_SKIP_ANSWER] };
      continue;
    }
    if (boundary.reason === 'cruise-integrity-drift-recovery') {
      answers[question.id] = { answers: [CRUISE_INTEGRITY_DRIFT_ANSWER] };
      continue;
    }
    if (boundary.reason === 'bounded-codex-worker-context' || boundary.reason === 'routine-delegation') {
      answers[question.id] = { answers: [boundary.reason === 'routine-delegation'
        ? ROUTINE_DELEGATION_ANSWER : BOUNDED_WORKER_PROCEED_ANSWER] };
      continue;
    }
    const choice = options.find((option) => GOAL_AUTHORIZATION_OPTION.test(optionLabel(option)));
    const value = optionValue(choice) ?? (
      boundary.action === AUTHORIZATION_ACTION.proceed
        ? PREAUTHORIZED_PROCEED_ANSWER
        : null
    );
    if (value === null) return null;
    answers[question.id] = { answers: [String(value)] };
  }
  return { answers };
}

export function automaticGoalProgress(params = {}, authorizationEvidence = {}) {
  return automaticRoutineGoalAdvance(params) ?? automaticGoalAuthorization(params, authorizationEvidence);
}

async function answerUserInput(params, { pickOne, readLine, input, output, lineReader }) {
  const answers = {};
  for (const question of params.questions ?? []) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length > 0) {
      const selection = await pickOne({
        title: `${question.header ?? ''}: ${question.question ?? ''}`.replace(/^: /u, ''),
        options,
        input,
        output,
        lineReader,
      });
      const value = selectionValue(selection);
      if (value === null) throw new SimpleCruiseInterruptedError();
      answers[question.id] = { answers: [String(value)] };
    } else {
      const answer = await readLine({
        prompt: `${question.question ?? 'Answer'}: `,
        input,
        output,
        lineReader,
      });
      answers[question.id] = { answers: [String(answer)] };
    }
  }
  return { answers };
}

export class CruiseApprovalChannelUnavailableError extends Error {
  constructor(reason = 'missing-selection') {
    super(`Cruise approval-channel-unavailable: the native approval input channel (stdin/host picker) is unavailable (${reason}). Invoke Cruise with an interactive approval channel or host supervision under the existing task authorization. No approval or refusal was recorded.`);
    this.name = 'CruiseApprovalChannelUnavailableError';
    this.code = 'CRUISE_APPROVAL_CHANNEL_UNAVAILABLE';
    this.category = 'approval-channel-unavailable';
    this.reason = reason;
  }
}

export function nativeApprovalOptions(decisions = ['accept', 'decline']) {
  const labels = {
    accept: 'Accept',
    acceptForSession: 'Accept for this session',
    decline: 'Decline',
    cancel: 'Cancel this turn',
  };
  return decisions.map((value) => {
    let label;
    if (typeof value === 'string') label = labels[value] ?? value;
    else if (value?.acceptWithExecpolicyAmendment) {
      label = `Accept with command policy amendment: ${JSON.stringify(value.acceptWithExecpolicyAmendment)}`;
    } else if (value?.applyNetworkPolicyAmendment) {
      label = `Apply network policy amendment: ${JSON.stringify(value.applyNetworkPolicyAmendment)}`;
    } else label = `Native decision: ${JSON.stringify(value)}`;
    return { label, value };
  });
}

export async function answerApproval(params = {}, { pickOne, input, output, lineReader }) {
  if (typeof pickOne !== 'function') throw new CruiseApprovalChannelUnavailableError('missing-picker');
  const selection = await pickOne({
    title: params.reason ?? params.command ?? 'Approve this action?',
    options: nativeApprovalOptions(params.availableDecisions ?? undefined),
    input,
    output,
    lineReader,
  });
  if (selection?.status === 'cancelled') {
    if (['q', 'escape', 'ctrl-c'].includes(selection.reason)) return 'cancel';
    throw new CruiseApprovalChannelUnavailableError(selection.reason ?? 'missing-selection');
  }
  const decision = selectionValue(selection);
  if (decision === null) throw new CruiseApprovalChannelUnavailableError();
  return decision;
}

/**
 * The dedicated migration CLI is its own fail-closed policy boundary. Let the
 * host run only that exact command family without surfacing a redundant native
 * approval. Raw database, Supabase, shell, and digest-authorized production
 * commands remain native decisions.
 */
export function automaticMigrationCommandApproval(params = {}) {
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  if (!command || /[;&|<>`$()\n\r]/u.test(command)) return null;
  if (/\s--(?:authorize-digest|db-url|password|include-seed|sandbox-first)(?:\s|=|$)/u.test(command)) return null;
  const launcher = /^(?:cruise|(?:\.?\.?\/|\/)[^\s]*\/cruise|node\s+(?:\.?\.?\/|\/)?[^\s]*scripts\/cruise\.mjs)\s+migrate\s+(?:inspect|apply|query|status)\b/u;
  if (!launcher.test(command)) return null;
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'decline'];
  return decisions.find((value) => /^accept(?:ForSession)?$/u.test(String(value))) ?? null;
}

export class SimpleCruiseInterruptedError extends Error {
  constructor() {
    super('Cruise was interrupted.');
    this.name = 'CruiseInterruptedError';
    this.code = 'CRUISE_INTERRUPTED';
  }
}

export class SimpleCruiseGoalBootstrapTimeoutError extends Error {
  constructor({
    deadlineMs,
    elapsedMs,
    threadId,
    model,
    goalStatus,
    goalReadError = null,
    pauseError = null,
  }) {
    const diagnostics = [
      `thread=${threadId ?? 'unknown'}`,
      `model=${model ?? 'unknown'}`,
      `goal=${goalStatus ?? 'unknown'}`,
      `elapsed=${formatDuration(elapsedMs)}`,
      ...(goalReadError ? [`goal-read-error=${goalReadError.message ?? goalReadError}`] : []),
      ...(pauseError ? [`pause-error=${pauseError.message ?? pauseError}`] : []),
    ].join(', ');
    super(
      `Codex never started the native Goal turn within ${formatDuration(deadlineMs)} (${diagnostics}).`,
    );
    this.name = 'CruiseGoalBootstrapTimeoutError';
    this.code = 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT';
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
    this.threadId = threadId;
    this.model = model;
    this.goalStatus = goalStatus;
    this.goalReadError = goalReadError;
    this.pauseError = pauseError;
  }
}

export class SimpleCruiseContextPressurePauseError extends Error {
  constructor(pressure) {
    super(`Cruise paused because context pressure remained at ${(pressure * 100).toFixed(1)}% after compaction.`);
    this.name = 'CruiseContextPressurePauseError';
    this.code = 'CRUISE_CONTEXT_PRESSURE_PAUSE';
    this.pressure = pressure;
  }
}

/**
 * A normal Codex session. Goal is the autonomous lane: its native Goal remains
 * active across as many ordinary turns as are needed to satisfy its evidence.
 */
export class SimpleCruiseSession extends EventEmitter {
  constructor({
    client,
    cwd,
    prompt,
    skill,
    skillPath,
    pickOne,
    readLine,
    lineReader = null,
    input = process.stdin,
    approvalsReviewer,
    output = process.stdout,
    errorOutput = process.stderr,
    supervisor = new GoalSupervisor(),
    assuranceSupervisor = new GoalSupervisor({
      maxTurns: DEFAULT_STALL.quietTurns + 2,
    }),
    requireAssurance = false,
    planOnly = false,
    externalSandbox = false,
    captureFingerprint = captureWorkspaceFingerprint,
    readPlan = inspectFlightPlan,
    firstTurnDeadlineMs = undefined,
    startupHeartbeatMs = 120_000,
    beforeGoalActivation = null,
    firstTurnCleanupDeadlineMs = DEFAULT_FIRST_TURN_CLEANUP_DEADLINE_MS,
    locateTrace = locateRollout,
    traceHome = codexHome(),
    clock = () => new Date(),
    runtimeDirectory = null,
    usageMeter = new UsageMeter(),
    compactionController = null,
    quotaGuard = null,
    rootOverride = null,
    cheaperDiagnostic = false,
    continuationContextReader = readContinuationContext,
  }) {
    super();
    if (!client || !cwd || !prompt || !skill || !skillPath) {
      throw new TypeError('client, cwd, prompt, skill, and skillPath are required');
    }
    this.client = client;
    if (typeof externalSandbox !== 'boolean') throw new TypeError('externalSandbox must be a boolean');
    if (externalSandbox && skill !== 'goal') throw new TypeError('externalSandbox requires a Codex Goal');
    this.externalSandbox = externalSandbox;
    this.cwd = cwd;
    this.prompt = prompt;
    this.skill = skill;
    if (skill !== 'goal' && approvalsReviewer !== undefined) {
      throw new TypeError('--approvals-reviewer is supported only by Codex Goal and worker.');
    }
    this.approvalsReviewer = skill === 'goal' ? resolveApprovalsReviewer(approvalsReviewer, { input }) : undefined;
    this.skillPath = skillPath;
    this.goalPreparationOnly = skill === 'goal' && (planOnly || isPreparationOnlyGoalPrompt(prompt));
    this.pickOne = pickOne;
    this.readLine = readLine;
    this.lineReader = lineReader;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.supervisor = supervisor;
    this.assuranceSupervisor = assuranceSupervisor;
    this.requireAssurance = requireAssurance;
    this.captureFingerprint = captureFingerprint;
    this.readPlan = readPlan;
    this.supervisorFlightHash = 'absent';
    this.firstTurnDeadlineMs = resolveFirstTurnDeadlineMs(firstTurnDeadlineMs);
    this.startupHeartbeatMs = startupHeartbeatMs;
    this.beforeGoalActivation = beforeGoalActivation;
    this.startupAbortController = new AbortController();
    this.workspaceActivated = beforeGoalActivation === null;
    this.bootstrapHandoff = '';
    this.firstTurnCleanupDeadlineMs = firstTurnCleanupDeadlineMs;
    this.locateTrace = locateTrace;
    this.traceHome = traceHome;
    this.clock = clock;
    this.runtimeDirectory = runtimeDirectory;
    this.usageMeter = usageMeter;
    this.quotaGuard = quotaGuard;
    this.rootRequest = skill === 'goal'
      ? selectRootRequest({ override: rootOverride, cheaperDiagnostic })
      : null;
    this.continuationContextReader = continuationContextReader;
    this.usagePersistence = Promise.resolve();
    this.runStartedAt = null;
    this.runFinalStatus = 'failed';
    this.rolloutPath = null;
    this.traceLookup = Promise.resolve();
    this.traceRetryStarted = false;
    this.turnAgentText = '';
    this.turnNativeApprovalDenied = false;
    this.authorizationRecoveryAttempted = false;
    this.threadId = null;
    this.threadModel = null;
    this.threadReasoningEffort = null;
    this.turnId = null;
    this.pending = null;
    this.earlyTurnResults = new Map();
    this.settledTurnIds = new Set();
    this.nativeGoalReconcileTimer = null;
    this.nativeGoalTurnDeadline = null;
    this.nativeGoalTurnHeartbeat = null;
    this.nativeGoalWatchdogPaused = false;
    this.nativeGoalTurnWaiting = false;
    this.nativeGoalTurnStarted = false;
    this.nativeGoalTurnTimedOut = false;
    this.nativeGoalCleanupCancelled = null;
    this.nativeGoalCleanupWaits = new Set();
    this.goal = null;
    this.interrupted = false;
    this.stopping = false;
    this.interactions = Promise.resolve();
    this.onRequest = (message) => this.enqueueRequest(message);
    this.onNotification = (message) => this.handleNotification(message);
    this.onExit = (info) => this.handleExit(info);
    this.compactionController = compactionController ?? new CompactionController({
      client: this.client,
      usageMeter: this.usageMeter,
      refreshHandoff: () => this.refreshCompactionHandoff(),
      persist: (summary) => {
        this.usageMeter.setCompaction(summary);
        return this.persistUsageNow();
      },
      now: this.clock,
    });
  }

  async run() {
    this.runStartedAt = this.timestamp();
    this.client.on('request', this.onRequest);
    this.client.on('notification', this.onNotification);
    this.client.on('exit', this.onExit);
    try {
      await this.waitForStartup(this.client.start());
      if (this.quotaGuard && !this.beforeGoalActivation) {
        await this.quotaGuard.start({
          client: this.client,
          goalId: this.runtimeDirectory ?? `cruise-${this.skill}`,
        });
      }
      if (this.skill === 'goal') this.errorOutput.write(`Cruise: app-server started.\nCruise: native approvals reviewer=${this.approvalsReviewer}; selection is not an approval result.\n`);
      const started = await this.waitForStartup(this.client.request('thread/start', {
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        ...(this.approvalsReviewer === undefined ? {} : { approvalsReviewer: this.approvalsReviewer }),
        sandbox: 'workspace-write',
        serviceName: 'cruise',
        ephemeral: false,
        ...(this.rootRequest
          ? {
              model: this.rootRequest.model,
              allowProviderModelFallback: false,
              config: {
                model_reasoning_effort: this.rootRequest.reasoning_effort,
              },
            }
          : {}),
        developerInstructions: [
          INDEPENDENT_RELEASE_INSTRUCTIONS,
          COLLABORATIVE_GIT_SYNC_INSTRUCTIONS,
          'Work directly with the user request and the repository.',
          ...(this.skill === 'goal' ? [] : [AUTHORIZATION_POLICY_INSTRUCTIONS]),
          'Cruise keeps .cruise/ORIGIN.md as a verbatim request note; Goal work may also maintain the user-editable advisory .cruise/FLIGHT.md.',
          'Root Markdown files whose basenames begin with an underscore are write-only user references: never read, summarize, fingerprint, search, or use their contents as context. Cruise updates them only through deterministic runtime code.',
          'This launcher records Goal user references automatically; do not run cruise reference from the hosted task.',
          'Do not create Cruise run-control files, approval digests, archives, or YAML workflow state. FLIGHT.md frontmatter is an advisory note, not workflow authority.',
          'Use normal Codex approvals and report failures factually.',
          ...(this.externalSandbox ? [this.externalSandboxInstructions()] : []),
          ...(this.approvalsReviewer === undefined ? [] : [nativeReviewerInstructions(this.approvalsReviewer)]),
          'Use Cruise context-view for repository retrieval so .env, credential, secret, and private-key exclusions are enforced before access.',
          skillTriggerInstructions(),
          ...(this.skill === 'goal'
            ? [
                'The root remains the Sol-high coordinator, integrator, and final reviewer. For each ready micro-goal, invoke `cruise worker --managed` with one bounded task, its classified complexity, and the required ownership, evidence, range, and verification fields. Let Cruise enforce consequence floors; use an explicit level only as a stronger override. Keep ownership disjoint, cap active workers at three, consume only `.cruise/HANDOFF.md`, its changed-path summary, and focused evidence, then let the ephemeral worker close. Debug starts with at most three evidence-distinct probes and expands only after confirmed evidence.',
                'The managed CLI starts a separate Codex control-plane transport. If its startup diagnostic reports an actual OS sandbox permission failure before a worker thread starts, request host-native approval for the exact bounded CLI command with its task justification under the existing user authorization. Keep the worker thread read-only when requested. Do not replace native approval with a new Cruise consent question. An OS sandbox failure is distinct from an automatic approval reviewer rejection; honor an actual rejection and never blindly retry it.',
              ]
            : []),
          ...(this.skill === 'goal' ? [AUTONOMOUS_GOAL_INSTRUCTIONS] : []),
        ].join(' '),
      }));
      this.threadId = started.thread.id;
      this.threadModel = started.model ?? this.rootRequest?.model ?? null;
      this.threadReasoningEffort = started.reasoningEffort ?? this.rootRequest?.reasoning_effort ?? null;
      if (this.rootRequest) {
        const resolvedModel = this.threadModel;
        const resolvedEffort = this.threadReasoningEffort;
        if (resolvedModel !== this.rootRequest.model || resolvedEffort !== this.rootRequest.reasoning_effort) {
          const error = new Error(
            `Goal root resolved to ${resolvedModel}/${resolvedEffort}; required ${this.rootRequest.model}/${this.rootRequest.reasoning_effort}`,
          );
          error.code = 'CRUISE_ROOT_POLICY_UNAVAILABLE';
          throw error;
        }
      }
      if (this.beforeGoalActivation) {
        // Warm transport/thread without taking mutation ownership. The parent
        // supplies its latest state only after relinquishing overlapping work.
        this.client.pauseInactivityWatchdog?.();
        try {
          this.bootstrapHandoff = await this.beforeGoalActivation({
            threadId: this.threadId,
            cwd: this.cwd,
            signal: this.startupAbortController.signal,
            session: this,
          });
        } finally {
          this.client.resumeInactivityWatchdog?.();
        }
        if (this.interrupted) throw new SimpleCruiseInterruptedError();
        if (this.startupAbortController.signal.aborted) throw this.startupAbortController.signal.reason;
        this.workspaceActivated = true;
        if (this.quotaGuard) {
          await this.quotaGuard.start({ client: this.client, goalId: this.runtimeDirectory ?? `cruise-${this.skill}` });
        }
      }
      await this.initializeTraceSignpost();
      if (this.skill === 'goal') {
        // Replace any prior run's liveness scratch before this run can finish
        // without entering the continuation loop.
        await this.persistSupervisor();
      }

      let result;
      let goalExecutionMode = false;
      let continuationCompleted = false;
      if (this.skill === 'goal') {
        await this.updateGoalMode('plan');
        const goalActivated = deferred();
        const nativeTurn = this.waitForNativeGoalTurn(goalActivated.promise);
        nativeTurn.catch(() => {});
        try {
          const activation = this.waitForStartup(this.activateGoal());
          await Promise.race([activation, nativeTurn.then(() => activation)]);
        } catch (error) {
          goalActivated.resolve();
          this.pending?.reject(error);
          await nativeTurn.catch(() => {});
          throw error;
        }
        this.errorOutput.write('Cruise: goal activated.\n');
        goalActivated.resolve();
        this.errorOutput.write('Cruise: waiting for the native Goal turn.\n');
        result = await nativeTurn;
      } else {
        result = await this.startTurn([
          { type: 'skill', name: this.skill, path: this.skillPath },
          {
            type: 'text',
            text: this.prompt,
            text_elements: [],
          },
        ]);
      }
      await this.afterCompletedTurn(result);
      while (this.skill === 'goal') {
        await this.interactions;
        if (result.status !== 'completed') {
          throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
        }
        const goal = await this.refreshGoal();
        const authorizationRecoveryKind = !this.authorizationRecoveryAttempted && (
          isCruiseIntegrityDriftAuthorizationPause(this.turnAgentText, {
            nativeApprovalDenied: this.turnNativeApprovalDenied,
          })
            ? 'cruise-integrity-drift'
            : isSpeculativeWorkerAuthorizationPause(this.turnAgentText, {
              nativeApprovalDenied: this.turnNativeApprovalDenied,
            }) ? 'worker-disclosure' : null
        );
        const authorizationRecoveryInstructions = authorizationRecoveryKind === 'cruise-integrity-drift'
          ? CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS
          : WORKER_AUTHORIZATION_RECOVERY_INSTRUCTIONS;
        const authorizationRecoveryDiagnostic = authorizationRecoveryKind === 'cruise-integrity-drift'
          ? 'Cruise: suppressed an unnecessary Cruise integrity-drift waiver; selectively reconciling and continuing.\n'
          : 'Cruise: suppressed a speculative Codex-worker disclosure authorization pause; continuing with bounded safe context.\n';
        if (authorizationRecoveryKind) this.authorizationRecoveryAttempted = true;
        if (authorizationRecoveryKind && TERMINAL_GOAL_STATUSES.has(goal?.status)) {
          this.errorOutput.write(authorizationRecoveryDiagnostic);
          result = await this.reactivateCompletedGoal(goal, authorizationRecoveryInstructions);
          await this.afterCompletedTurn(result);
          goalExecutionMode = true;
          continuationCompleted = true;
          continue;
        }
        if (TERMINAL_GOAL_STATUSES.has(goal?.status)) {
          if (goal.status === 'complete' && !this.goalPreparationOnly) {
            const assessment = await this.assessCompletion();
            if (assessment.allowsCompletion) {
              if (assessment.level !== 'legacy-unattested') {
                this.errorOutput.write(
                  `Cruise: ${assessment.level} completion (${assessment.metrics.closed}/${assessment.metrics.total} gates closed).\n`,
                );
              }
              return this.finishResult({
                status: goal.status,
                skill: this.skill,
                threadId: this.threadId,
                goal,
              });
            }
            const verdict = this.assuranceSupervisor.recordTurn({
              fingerprint: assessment.progressFingerprint,
              failureSignature: null,
              turnId: result?.id ?? null,
            });
            if (verdict.level === 'stall') {
              const report = [
                'Cruise Goal stopped after repeated unchanged unassured completion attempts.',
                ...assessment.reasons.map((reason) => `- ${reason}`),
              ].join('\n');
              this.errorOutput.write(`${report}\n`);
              return this.finishResult({
                status: 'stalled',
                skill: this.skill,
                threadId: this.threadId,
                goal,
                assurance: assessment,
              });
            }
            await this.prepareExpensiveContinuation();
            const correctionContext = await this.continuationContextReader(this.cwd);
            result = await this.reactivateCompletedGoal(
              goal,
              `${assuranceCorrectionInstructions(assessment)}\n\n${correctionContext}`,
            );
            await this.afterCompletedTurn(result);
            goalExecutionMode = true;
            continuationCompleted = true;
            continue;
          }
          return this.finishResult({ status: goal.status, skill: this.skill, threadId: this.threadId, goal });
        }
        if (goal?.status !== 'active') {
          throw new Error(`Cruise Goal entered unsupported status ${String(goal?.status ?? 'missing')}.`);
        }
        if (this.goalPreparationOnly) {
          const completed = await this.completePreparedGoal(goal);
          return this.finishResult({
            status: completed.status,
            skill: this.skill,
            threadId: this.threadId,
            goal: completed,
          });
        }
        let continuationInstructions = authorizationRecoveryKind
          ? authorizationRecoveryInstructions
          : GOAL_CONTINUATION_INSTRUCTIONS;
        if (authorizationRecoveryKind) {
          this.errorOutput.write(authorizationRecoveryDiagnostic);
        }
        if (continuationCompleted) {
          const verdict = await this.superviseGoalTurn(result?.id ?? null);
          if (verdict.level === 'stall') {
            let pauseError = null;
            try {
              await this.pauseActiveGoal();
            } catch (error) {
              pauseError = error;
            }
            const report = stallReport(verdict, this.supervisor.summary(), { pauseError });
            this.errorOutput.write(`${report}\n`);
            await this.persistSupervisor({
              finalReport: report,
              pauseOutcome: pauseError
                ? { status: 'pause-failed', reason: String(pauseError?.message ?? pauseError) }
                : { status: 'paused' },
            });
            return this.finishResult({
              status: 'stalled',
              skill: this.skill,
              threadId: this.threadId,
              goal: this.goal,
            });
          }
          if (!authorizationRecoveryKind) {
            if (verdict.level === 'corrective') continuationInstructions = correctiveFlightInstructions(verdict.reason);
            else if (verdict.level === 'realign') continuationInstructions = realignmentInstructions(verdict.reason);
            else if (verdict.level === 'final-experiment') continuationInstructions = finalExperimentInstructions(verdict.reason);
          }
        }
        if (!goalExecutionMode) {
          await this.updateGoalMode('default');
          goalExecutionMode = true;
        }
        await this.prepareExpensiveContinuation();
        const continuationContext = await this.continuationContextReader(this.cwd);
        result = await this.startTurn([
          {
            type: 'text',
            text: `${continuationInstructions}\n\n${continuationContext}`,
            text_elements: [],
          },
        ], { mode: 'default' });
        await this.afterCompletedTurn(result);
        continuationCompleted = true;
      }
      await this.interactions;
      if (result.status !== 'completed') {
        throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
      }
      return this.finishResult({ status: 'complete', skill: this.skill, threadId: this.threadId });
    } catch (error) {
      if (['CRUISE_BUDGET_PAUSE', 'CRUISE_CONTEXT_PRESSURE_PAUSE'].includes(error?.code)) {
        await this.pauseActiveGoal().catch(() => {});
      }
      this.runFinalStatus = this.interrupted
        ? 'interrupted'
        : error?.code === 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT'
          ? 'bootstrap-timeout'
          : error?.code === 'CRUISE_BUDGET_PAUSE'
            ? 'budget-paused'
            : error?.code === 'CRUISE_CONTEXT_PRESSURE_PAUSE'
              ? 'context-paused'
              : 'failed';
      throw error;
    } finally {
      this.stopping = true;
      this.startupAbortController.abort(new Error('Cruise session stopped.'));
      this.client.off?.('request', this.onRequest);
      this.client.off?.('notification', this.onNotification);
      this.client.off?.('exit', this.onExit);
      await this.traceLookup.catch(() => {});
      await this.usagePersistence.catch(() => {});
      if (this.threadId && this.workspaceActivated) {
        await this.persistRunPointer({
          finalStatus: this.runFinalStatus,
          endedAt: this.timestamp(),
        });
        if (this.usageMeter.summary().observed_threads > 0 || this.compactionController.summary().attempts > 0) {
          await this.persistUsageNow().catch(() => {});
        }
        this.printClosingTraceSignpost();
      }
      await this.quotaGuard?.release().catch(() => {});
      await this.client.stop().catch(() => {});
    }
  }

  timestamp() {
    const value = new Date(this.clock());
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }

  finishResult(result) {
    this.runFinalStatus = result.status;
    return result;
  }

  async afterCompletedTurn(turn) {
    if (turn?.status !== 'completed') return;
    await this.interactions;
    const result = await this.compactionController.afterTurn({
      threadId: this.threadId,
      activeTurn: this.turnId !== null,
    });
    this.usageMeter.setCompaction(this.compactionController.summary());
    if (result.action === 'compacted') await this.persistUsageNow();
  }

  async prepareExpensiveContinuation() {
    if (this.quotaGuard) await this.quotaGuard.check();
    if (!this.compactionController.shouldSplitOrPause()) return;
    await this.refreshCompactionHandoff();
    const pressure = this.usageMeter.thread(this.threadId)?.pressure ?? 1;
    throw new SimpleCruiseContextPressurePauseError(pressure);
  }

  scheduleUsagePersistence() {
    this.usagePersistence = this.usagePersistence
      .then(() => this.persistUsageNow())
      .catch((error) => {
        this.errorOutput.write(
          `Cruise warning: could not persist usage: ${String(error?.message ?? error).replace(/\s+/gu, ' ').trim()}.\n`,
        );
      });
  }

  async persistUsageNow() {
    if (!this.workspaceActivated) return;
    this.usageMeter.setCompaction(this.compactionController.summary());
    await this.usageMeter.persist(this.cwd);
  }

  async refreshCompactionHandoff() {
    const directory = await ensureCruiseScratch(this.cwd, CONTEXT_STATE_FILES);
    const usage = this.usageMeter.thread(this.threadId);
    let prior = '';
    try {
      prior = await readFile(`${directory}/HANDOFF.md`, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const field = (label) => prior.match(new RegExp(`^- ${label}: (.+)$`, 'mu'))?.[1] ?? null;
    const compact = field('Compact handoff') ?? 'Completed state remains in the current diff and focused evidence pointers.';
    const inspection = await Promise.resolve().then(() => this.readPlan(this.cwd)).catch(() => null);
    const pendingGate = inspection?.state === 'valid' && inspection.plan.version >= 2
      ? inspection.plan.quality.gates.find(({ state }) => state !== 'passed')
      : null;
    const nextWork = field('Next work item') ?? field('Active blocker or next work item') ?? (pendingGate
      ? `Close Flight gate ${pendingGate.id} using its affected surface and evidence pointer.`
      : 'Continue the active bounded micro-goal.');
    const unresolved = inspection?.state === 'valid' && inspection.plan.version >= 2
      ? inspection.plan.quality.gates.filter(({ state }) => state !== 'passed').map(({ id }) => id).join(', ') || 'none by state; confirm freshness'
      : 'Flight assurance digest unavailable';
    const lines = [
      '# Cruise continuation',
      '',
      `- Compact handoff: ${truncateUtf8(compact, 1_800)}`,
      `- Next work item: ${truncateUtf8(nextWork, 800)}`,
      `- Quota state: accounting known ${usage?.accountingKnown ?? false}; context pressure ${Number.isFinite(usage?.pressure) ? usage.pressure.toFixed(4) : 'unknown'}; quota guard checked before continuation.`,
      `- Unresolved assurance: ${truncateUtf8(unresolved, 800)}.`,
      '',
    ];
    const content = lines.join('\n');
    if (Buffer.byteLength(content) > MAX_HANDOFF_BYTES) {
      throw new Error(`compaction handoff exceeds ${MAX_HANDOFF_BYTES} bytes`);
    }
    await atomicWriteText(`${directory}/HANDOFF.md`, content);
  }

  async initializeTraceSignpost() {
    this.errorOutput.write(
      `Cruise: thread ${this.threadId} started (model ${this.threadModel ?? 'unknown'}).\n`,
    );
    this.rolloutPath = await Promise.resolve()
      .then(() => this.locateTrace(this.threadId, {
        home: this.traceHome,
        now: new Date(this.runStartedAt),
      }))
      .catch(() => null);
    if (this.rolloutPath) {
      this.printResolvedTrace('rollout');
    } else {
      this.errorOutput.write(
        `Cruise: rollout pending; sessions: ${codexSessionsDirectory(this.traceHome)}; resume: codex resume ${this.threadId}.\n`,
      );
    }
    await this.persistRunPointer({ finalStatus: 'running', endedAt: null });
  }

  retryTraceAfterTurnStart() {
    if (this.traceRetryStarted || this.rolloutPath || !this.threadId) return;
    this.traceRetryStarted = true;
    this.traceLookup = this.traceLookup.then(async () => {
      const path = await Promise.resolve()
        .then(() => this.locateTrace(this.threadId, {
          home: this.traceHome,
          now: new Date(this.clock()),
        }))
        .catch(() => null);
      if (!path) return;
      this.rolloutPath = path;
      this.printResolvedTrace('rollout');
      await this.persistRunPointer({ finalStatus: 'running', endedAt: null });
    });
  }

  printResolvedTrace(label) {
    this.errorOutput.write(
      `Cruise: ${label}: ${this.rolloutPath}; tail -f ${shellQuote(this.rolloutPath)}.\n`,
    );
  }

  printClosingTraceSignpost() {
    if (this.rolloutPath) {
      this.printResolvedTrace('trace');
      return;
    }
    this.errorOutput.write(
      `Cruise: trace unresolved for thread ${this.threadId}; sessions: ${codexSessionsDirectory(this.traceHome)}; resume: codex resume ${this.threadId}.\n`,
    );
  }

  async persistRunPointer({ finalStatus, endedAt }) {
    try {
      const usage = this.usageMeter.summary();
      const usageFields = usage.observed_threads > 0
        ? {
            usage: {
              accounting_known: usage.accounting_known,
              rate_version: usage.rate_version,
              totals: usage.totals,
              estimated_credits: usage.estimated_credits,
            },
            compaction: this.compactionController.summary(),
          }
        : {};
      await writeCruiseScratchJson(this.cwd, 'LAST-RUN.json', {
        thread_id: this.threadId,
        rollout_path: this.rolloutPath,
        cwd: this.cwd,
        skill: this.skill,
        started_at: this.runStartedAt,
        ended_at: endedAt,
        final_status: finalStatus,
        ...(this.rootRequest
          ? {
              root_policy: {
                role: 'coordinator_integrator_final_reviewer',
                requested_model: this.rootRequest.model,
                requested_reasoning_effort: this.rootRequest.reasoning_effort,
                resolved_model: this.threadModel,
                resolved_reasoning_effort: this.threadReasoningEffort,
                source: this.rootRequest.source,
                cheaper_diagnostic: this.rootRequest.cheaper_diagnostic,
              },
            }
          : {}),
        ...usageFields,
      });
    } catch (error) {
      this.errorOutput.write(
        `Cruise warning: could not persist run pointer: ${String(error?.message ?? error).replace(/\s+/gu, ' ').trim()}.\n`,
      );
    }
  }

  async activateGoal() {
    if (this.interrupted) throw new SimpleCruiseInterruptedError();
    const current = await this.client.request('thread/goal/get', { threadId: this.threadId });
    if (this.interrupted) throw new SimpleCruiseInterruptedError();
    if (current?.goal) {
      throw new Error(`Cruise cannot replace the existing native Goal (${current.goal.status}).`);
    }
    const fullObjective = [
      `Autonomously complete the user's Cruise Goal: ${this.prompt}`,
      GOAL_BOOTSTRAP_INSTRUCTIONS,
      'Use each codebase-aware plan to launch the next ready micro-goal, then implement, verify, realign, and continue without routine phase approvals.',
    ].join(' ');
    // Native Goal objectives are capped at 4000 characters. Full scope and
    // the fresh capsule are supplied through collaboration-mode instructions.
    const objective = fullObjective.length <= 4000 ? fullObjective
      : 'Complete the original user request provided in the collaboration-mode instructions. Reconcile the latest parent handoff, then plan, implement and verify within that exact scope.';
    const activated = await this.client.request('thread/goal/set', {
      origin: 'user',
      threadId: this.threadId,
      objective,
      status: 'active',
    });
    if (activated?.goal?.status !== 'active') {
      throw new Error('Codex did not confirm the native Goal as active.');
    }
    this.goal = activated.goal;
    if (this.interrupted) {
      await this.pauseActiveGoal();
      throw new SimpleCruiseInterruptedError();
    }
  }

  async refreshGoal() {
    const result = await this.client.request('thread/goal/get', { threadId: this.threadId });
    this.goal = result?.goal ?? null;
    return this.goal;
  }

  async completePreparedGoal(goal) {
    const completed = await this.client.request('thread/goal/set', {
      origin: 'automatic',
      threadId: this.threadId,
      objective: goal.objective,
      status: 'complete',
    });
    if (completed?.goal?.status !== 'complete') {
      throw new Error('Codex did not confirm the prepared Goal as complete.');
    }
    this.goal = completed.goal;
    return this.goal;
  }

  async reactivateCompletedGoal(goal, instructions) {
    // Native reactivation may start a turn before an explicit turn/start.
    await this.updateGoalMode('default');
    const activated = deferred();
    const nativeTurn = this.waitForNativeGoalTurn(activated.promise, {
      mode: 'default', instructions,
    });
    nativeTurn.catch(() => {});
    try {
      const mutation = this.waitForStartup(this.client.request('thread/goal/set', {
        origin: 'automatic',
        threadId: this.threadId,
        objective: `${goal.objective}\n\nCompletion correction:\n${instructions}`,
        status: 'active',
      }));
      const result = await Promise.race([mutation, nativeTurn.then(() => mutation)]);
      this.goal = result?.goal ?? null;
      if (this.goal?.status !== 'active') {
        throw new Error('Codex did not reactivate the unassured Goal.');
      }
      activated.resolve();
      return await nativeTurn;
    } catch (error) {
      this.startupAbortController.abort(error);
      activated.resolve();
      this.pending?.reject(error);
      await nativeTurn.catch(() => {});
      throw error;
    }
  }

  async assessCompletion() {
    const inspection = await Promise.resolve()
      .then(() => this.readPlan(this.cwd))
      .catch((error) => ({ state: 'invalid', reason: String(error?.message ?? error) }));
    if (inspection?.state !== 'valid') {
      const state = inspection?.state ?? 'absent';
      const reason = state === 'invalid'
        ? `Flight is invalid: ${inspection.reason ?? 'unknown parse failure'}`
        : 'Flight is absent';
      if (!this.requireAssurance) {
        return {
          level: 'legacy-unattested',
          allowsCompletion: true,
          reasons: [reason],
          progressFingerprint: `flight-${inspection?.contentHash ?? state}`,
          contextFingerprint: null,
          metrics: { total: 0, closed: 0, fresh: 0, passed: 0, waived: 0 },
        };
      }
      return {
        level: 'incomplete',
        allowsCompletion: false,
        reasons: [reason],
        progressFingerprint: `flight-${inspection?.contentHash ?? state}`,
        contextFingerprint: null,
        metrics: { total: 0, closed: 0, fresh: 0, passed: 0, waived: 0 },
      };
    }
    const { plan } = inspection;
    if (plan.version < 2) {
      const assessment = evaluateFlightAssurance(plan, null);
      return !this.requireAssurance && !assessment.allowsCompletion
        ? { ...assessment, allowsCompletion: true }
        : assessment;
    }
    const workspaceFingerprint = await this.captureFingerprint(this.cwd, {
      excludeFlightPlan: true,
    });
    if (!workspaceFingerprint) {
      return {
        level: 'incomplete',
        allowsCompletion: false,
        reasons: ['Product workspace fingerprint is unavailable; evidence freshness cannot be established.'],
        progressFingerprint: 'workspace-fingerprint-unavailable',
        contextFingerprint: null,
        metrics: { total: plan.quality.gates.length, closed: 0, fresh: 0, passed: 0, waived: 0 },
      };
    }
    let assuranceContext;
    try {
      assuranceContext = await captureFlightAssuranceContext(this.cwd, plan, {
        workspaceFingerprint,
        surfaceFingerprintReader: (paths) => this.captureFingerprint(this.cwd, {
          excludeFlightPlan: true,
          paths,
        }),
      });
    } catch (error) {
      return {
        level: 'incomplete',
        contractClosed: false,
        readyForCompletion: false,
        allowsCompletion: false,
        reasons: [String(error?.message ?? error)],
        progressFingerprint: 'request-binding-unavailable',
        contextFingerprint: null,
        metrics: { total: plan.quality.gates.length, closed: 0, fresh: 0, passed: 0, waived: 0 },
      };
    }
    const assessment = evaluateFlightAssurance(plan, assuranceContext);
    const result = {
      ...assessment,
      contextFingerprint: assuranceContext.contextFingerprint,
      gateFingerprints: assuranceContext.gateFingerprints,
    };
    if (this.runtimeDirectory) {
      await writeRuntimeJson(this.runtimeDirectory, 'attestation.json', {
        version: 2,
        host: 'codex',
        level: result.level,
        context_fingerprint: assuranceContext.contextFingerprint,
        gate_fingerprints: assuranceContext.gateFingerprints,
        reasons: result.reasons,
        metrics: result.metrics,
        observed_at: Date.now(),
      }).catch(() => {});
    }
    return result;
  }

  externalSandboxInstructions() {
    return 'The operator explicitly selected --external-sandbox and declares that an outer sandbox is already enforced. Cruise cannot prove that boundary is correct. Pass --external-sandbox to managed workers only within the same enforced outer boundary; never infer isolation from a fresh directory. Plan work and read-only workers must remain read-only: do not mutate product files, and the outer sandbox must enforce those bounds. External sandbox policy alone supplies no read-only guarantee. Preserve normal native approvals and reviewer denials; never use this mode as an automatic fallback after a permission failure.';
  }

  turnSandboxPolicy(readOnly = false) {
    if (this.externalSandbox) return { type: 'externalSandbox', networkAccess: 'restricted' };
    return readOnly ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [this.cwd] };
  }

  goalTurnSettings(mode) {
    const collaborationMode = { mode };
    const model = this.rootRequest?.model ?? this.threadModel;
    const reasoningEffort = this.rootRequest?.reasoning_effort ?? this.threadReasoningEffort;
    if (model) {
      collaborationMode.settings = {
        model,
        ...(reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : {}),
        developer_instructions: [
          COLLABORATIVE_GIT_SYNC_INSTRUCTIONS,
          AUTONOMOUS_GOAL_INSTRUCTIONS,
          ...(this.externalSandbox ? [this.externalSandboxInstructions(),
            ...(mode === 'plan' ? ['This is read-only Plan mode. Analyze and plan only; do not edit product files or execute mutations.'] : []),
          ] : []),
          nativeReviewerInstructions(this.approvalsReviewer),
          `Original user request (scope source):\n${this.prompt}`,
          ...(this.bootstrapHandoff ? [this.bootstrapHandoff] : []),
        ].join(' '),
      };
    }
    return {
      collaborationMode,
      approvalsReviewer: this.approvalsReviewer,
      sandboxPolicy: this.turnSandboxPolicy(mode === 'plan'),
    };
  }

  async updateGoalMode(mode) {
    const settings = this.goalTurnSettings(mode);
    await this.waitForStartup(this.client.request('thread/settings/update', {
      threadId: this.threadId,
      cwd: this.cwd,
      approvalPolicy: 'on-request',
      ...settings,
    }));
  }

  waitForStartup(promise) {
    const signal = this.startupAbortController.signal;
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        signal.removeEventListener('abort', cancel);
        callback(value);
      };
      const cancel = () => finish(reject, signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(promise).then(
        value => finish(resolve, value), error => finish(reject, error),
      );
      if (signal.aborted) cancel();
    });
  }

  async startTurn(input, { mode = null } = {}) {
    this.turnAgentText = '';
    this.turnNativeApprovalDenied = false;
    const completion = deferred();
    completion.promise.catch(() => {});
    this.turnId = null;
    this.pending = completion;
    try {
      const goalSettings = mode === null ? null : this.goalTurnSettings(mode);
      const turn = await this.client.request('turn/start', {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        ...(this.approvalsReviewer === undefined ? {} : { approvalsReviewer: this.approvalsReviewer }),
        ...(goalSettings ?? {
          sandboxPolicy: this.turnSandboxPolicy(),
        }),
      });
      if (this.pending === completion) {
        this.turnId = turn.turn.id;
        this.resolveEarlyTurnResult(turn.turn.id);
      }
      return await completion.promise;
    } finally {
      if (this.pending === completion) {
        this.pending = null;
        this.earlyTurnResults.clear();
      }
    }
  }

  clearNativeGoalTurnDeadline() {
    if (this.nativeGoalTurnHeartbeat !== null) {
      clearInterval(this.nativeGoalTurnHeartbeat);
      this.nativeGoalTurnHeartbeat = null;
    }
    if (this.nativeGoalWatchdogPaused) {
      this.nativeGoalWatchdogPaused = false;
      this.client.resumeInactivityWatchdog?.();
    }
    if (this.nativeGoalTurnDeadline !== null) {
      clearTimeout(this.nativeGoalTurnDeadline);
      this.nativeGoalTurnDeadline = null;
    }
  }

  adoptNativeGoalTurn(turn) {
    if (!turn?.id || this.settledTurnIds.has(turn.id) || !this.pending || this.nativeGoalTurnTimedOut) return;
    if (this.turnId && this.turnId !== turn.id) return;
    this.nativeGoalTurnStarted = true;
    this.clearNativeGoalTurnDeadline();
    this.turnId = turn.id;
    this.resolveEarlyTurnResult(turn.id);
    if (['completed', 'failed', 'interrupted'].includes(turn.status)) {
      this.settleTurn(turn.id, { turn });
    }
  }

  waitWithinBootstrapCleanup(promise, deadlineMs, label, reportedDeadlineMs = deadlineMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let entry;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.nativeGoalCleanupWaits.delete(entry);
        callback(value);
      };
      entry = {
        cancel: (error) => finish(reject, error),
      };
      this.nativeGoalCleanupWaits.add(entry);
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
      if (this.nativeGoalCleanupCancelled) {
        entry.cancel(this.nativeGoalCleanupCancelled);
      } else {
        timer = setTimeout(() => {
          finish(reject, new Error(
            `${label} did not settle within ${formatDuration(reportedDeadlineMs)}.`,
          ));
        }, deadlineMs);
      }
    });
  }

  cancelNativeGoalCleanup(error) {
    this.nativeGoalCleanupCancelled = error;
    for (const entry of [...this.nativeGoalCleanupWaits]) entry.cancel(error);
  }

  async expireNativeGoalTurnDeadline(completion, startedAt) {
    if (this.pending !== completion || this.nativeGoalTurnStarted) return;
    this.nativeGoalTurnTimedOut = true;
    const cleanupDeadline = Date.now() + this.firstTurnCleanupDeadlineMs;
    const remainingCleanupMs = () => Math.max(0, cleanupDeadline - Date.now());
    let goalStatus = this.goal?.status ?? 'unknown';
    let goalReadError = null;
    try {
      const current = await this.waitWithinBootstrapCleanup(
        this.client.request('thread/goal/get', { threadId: this.threadId }),
        remainingCleanupMs(),
        'thread/goal/get after the native Goal bootstrap timeout',
        this.firstTurnCleanupDeadlineMs,
      );
      this.goal = current?.goal ?? null;
      goalStatus = this.goal?.status ?? 'missing';
    } catch (error) {
      goalReadError = error;
    }
    if (this.pending !== completion || this.nativeGoalCleanupCancelled) return;
    let pauseError = null;
    try {
      await this.waitWithinBootstrapCleanup(
        this.pauseActiveGoal(),
        remainingCleanupMs(),
        'Goal pause after the native Goal bootstrap timeout',
        this.firstTurnCleanupDeadlineMs,
      );
    } catch (error) {
      pauseError = error;
    }
    if (this.pending !== completion || this.nativeGoalCleanupCancelled) return;
    completion.reject(new SimpleCruiseGoalBootstrapTimeoutError({
      deadlineMs: this.firstTurnDeadlineMs,
      elapsedMs: Date.now() - startedAt,
      threadId: this.threadId,
      model: this.threadModel,
      goalStatus,
      goalReadError,
      pauseError,
    }));
  }

  async waitForNativeGoalTurn(goalActivated = Promise.resolve(), {
    mode = 'plan', instructions = GOAL_BOOTSTRAP_INSTRUCTIONS,
  } = {}) {
    this.turnAgentText = '';
    this.turnNativeApprovalDenied = false;
    const completion = deferred();
    completion.promise.catch(() => {});
    let settled = false;
    for (const key of ['resolve', 'reject']) {
      const finish = completion[key];
      completion[key] = value => { settled = true; finish(value); };
    }
    this.turnId = null;
    this.pending = completion;
    this.nativeGoalTurnWaiting = true;
    this.nativeGoalWatchdogPaused = true;
    this.client.pauseInactivityWatchdog?.();
    this.nativeGoalTurnStarted = false;
    this.nativeGoalTurnTimedOut = false;
    this.nativeGoalCleanupCancelled = null;
    let startRequested = false;
    const live = () => !settled && this.pending === completion && !this.nativeGoalTurnTimedOut;
    const read = (method, params) => this.waitWithinBootstrapCleanup(
      this.client.request(method, params), this.firstTurnCleanupDeadlineMs,
      `${method} during native Goal reconciliation`,
    );
    const reconcile = async () => {
      if (!live()) return;
      const metadata = await read('thread/read', { threadId: this.threadId, includeTurns: false });
      if (!live()) return;
      const history = await read('thread/turns/list', {
        threadId: this.threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary',
      });
      if (!live()) return;
      if (!Array.isArray(history?.data)) throw new Error('Codex returned invalid native Goal turn history.');
      // Only the latest turn can belong to this activation. Older completed
      // turns (including the turn that caused reactivation) are never replayed.
      const turn = this.turnId
        ? history.data.find(candidate => candidate.id === this.turnId)
        : history.data[0];
      this.adoptNativeGoalTurn(turn);
      if (!live()) return;
      const status = metadata?.thread?.status?.type;
      if (!['active', 'idle', 'notLoaded'].includes(status)) {
        throw new Error(`Codex native Goal thread status is ${String(status ?? 'missing')}.`);
      }
      if (!this.nativeGoalTurnStarted && !startRequested && status !== 'active') {
        // Set the guard before sending: a lost reply is ambiguous acceptance,
        // never permission to retry. History/notifications can still adopt it.
        startRequested = true;
        this.errorOutput.write(`Cruise: starting explicit ${mode === 'plan' ? 'Plan bootstrap' : 'Goal correction'} turn.\n`);
        void this.client.request('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: instructions, text_elements: [] }],
          cwd: this.cwd, runtimeWorkspaceRoots: [], approvalPolicy: 'on-request',
          ...this.goalTurnSettings(mode),
        }).then(response => {
          if (live()) this.adoptNativeGoalTurn(response?.turn);
        }, error => { if (live()) completion.reject(error); });
      }
      if (live()) this.nativeGoalReconcileTimer = setTimeout(() => {
        this.nativeGoalReconcileTimer = null;
        void reconcile().catch(error => { if (live()) completion.reject(error); });
      }, 250);
    };
    try {
      if (!this.nativeGoalTurnStarted && this.pending === completion) {
        const startedAt = Date.now();
        if (this.startupHeartbeatMs > 0) {
          this.nativeGoalTurnHeartbeat = setInterval(() => {
            this.errorOutput.write(`Cruise: still waiting for native Goal startup; elapsed=${formatDuration(Date.now() - startedAt)}, thread=${this.threadId}. Reconciling native turn history; no start request will be retried.\n`);
          }, this.startupHeartbeatMs);
          this.nativeGoalTurnHeartbeat.unref?.();
        }
        if (this.firstTurnDeadlineMs > 0) {
          this.nativeGoalTurnDeadline = setTimeout(() => {
            this.nativeGoalTurnDeadline = null;
            void this.expireNativeGoalTurnDeadline(completion, startedAt);
          }, this.firstTurnDeadlineMs);
        }
      }
      await Promise.race([goalActivated, completion.promise]);
      if (live()) {
        const poll = () => {
          this.nativeGoalReconcileTimer = null;
          void reconcile().catch(error => { if (live()) completion.reject(error); });
        };
        // A delivered start is already authoritative; give its normal completion
        // notification a chance before hydrating a bounded history page.
        if (this.nativeGoalTurnStarted) this.nativeGoalReconcileTimer = setTimeout(poll, 250);
        else poll();
      }
      return await completion.promise;
    } finally {
      if (this.nativeGoalReconcileTimer !== null) clearTimeout(this.nativeGoalReconcileTimer);
      this.nativeGoalReconcileTimer = null;
      this.cancelNativeGoalCleanup(new Error('Native Goal reconciliation finished.'));
      this.clearNativeGoalTurnDeadline();
      if (this.pending === completion) {
        this.pending = null;
        this.earlyTurnResults.clear();
      }
      this.nativeGoalTurnWaiting = false;
      this.nativeGoalTurnStarted = false;
      this.nativeGoalTurnTimedOut = false;
    }
  }

  resolveEarlyTurnResult(turnId) {
    const early = this.earlyTurnResults.get(turnId);
    if (!early || !this.pending || this.turnId !== turnId) return;
    this.earlyTurnResults.delete(turnId);
    this.settleTurn(turnId, early);
  }

  settleTurn(turnId, { turn = null, error = null } = {}) {
    if (!this.pending || !turnId) return;
    if (this.settledTurnIds.has(turnId)) return;
    if (turn?.status === 'failed' && !error) error = new Error(turn.error?.message ?? 'Cruise turn failed.');
    if (this.turnId === null) {
      if (this.nativeGoalTurnWaiting && !this.nativeGoalTurnTimedOut) {
        this.nativeGoalTurnStarted = true;
        this.clearNativeGoalTurnDeadline();
        this.turnId = turnId;
      } else {
        this.earlyTurnResults.set(turnId, { turn, error });
        return;
      }
    }
    if (turnId !== this.turnId) return;
    this.settledTurnIds.add(turnId);
    this.turnId = null;
    if (error) this.pending.reject(error);
    else this.pending.resolve(turn);
  }

  async interrupt() {
    this.interrupted = true;
    this.clearNativeGoalTurnDeadline();
    const interruption = new SimpleCruiseInterruptedError();
    this.startupAbortController.abort(interruption);
    this.cancelNativeGoalCleanup(interruption);
    this.pending?.reject(interruption);
    this.client.interrupt?.();
    this.lineReader?.cancel?.('ctrl-c');
    const controls = (async () => {
      if (this.threadId && this.turnId) {
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId,
        }).catch(() => {});
      }
      await this.pauseActiveGoal().catch(() => {});
    })();
    let cleanupTimer;
    try {
      await Promise.race([
        controls,
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, this.firstTurnCleanupDeadlineMs); }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
      // Cancellation must also break initialize/activation/control RPCs that
      // never reply. Stopping this task's transport is idempotent and bounded.
      await this.client.stop().catch(() => {});
    }
  }

  async pauseActiveGoal() {
    if (!this.threadId) return;
    const current = this.goal ?? (await this.client.request('thread/goal/get', {
      threadId: this.threadId,
    })).goal;
    if (current?.status !== 'active') return;
    const paused = await this.client.request('thread/goal/set', {
      origin: 'automatic',
      threadId: this.threadId,
      objective: current.objective,
      status: 'paused',
    });
    this.goal = paused?.goal ?? { ...current, status: 'paused' };
  }

  async superviseGoalTurn(turnId = null) {
    const rawInspection = await Promise.resolve()
      .then(() => this.readPlan(this.cwd))
      .catch(() => null);
    const inspection = rawInspection?.state
      ? rawInspection
      : rawInspection
        ? { state: 'valid', plan: rawInspection, contentHash: 'valid-unhashed' }
        : { state: 'absent' };
    const fingerprint = await Promise.resolve()
      .then(() => this.captureFingerprint(this.cwd, {
        // FLIGHT.md is advisory supervisor metadata, never product progress.
        excludeFlightPlan: true,
      }))
      .catch(() => null);
    const plan = inspection.state === 'valid' ? inspection.plan : null;
    this.supervisorFlightHash = inspection.contentHash ?? inspection.state;
    this.supervisor.updateStall(plan?.stall ?? DEFAULT_STALL);
    const verdict = this.supervisor.recordTurn({
      fingerprint,
      failureSignature: extractFailureSignature(this.turnAgentText),
      turnId,
      corrective: inspection.state === 'invalid'
        ? { contentHash: inspection.contentHash, reason: inspection.reason }
        : null,
    });
    if (inspection.state === 'invalid') {
      this.errorOutput.write(`Cruise warning: supervision degraded: invalid .cruise/FLIGHT.md (${inspection.reason}).\n`);
    }
    await this.persistSupervisor();
    return verdict;
  }

  async persistSupervisor({ finalReport = null, pauseOutcome = null } = {}) {
    if (!this.runtimeDirectory) return;
    try {
      await writeSupervisorState(this.runtimeDirectory, this.supervisor.state({
        flightHash: this.supervisorFlightHash,
        finalReport,
        pauseOutcome,
      }));
    } catch (error) {
      this.errorOutput.write(`Cruise warning: could not persist supervisor scratch: ${String(error?.message ?? error).replace(/\s+/gu, ' ').trim()}.\n`);
    }
  }

  enqueueRequest(message) {
    this.interactions = this.interactions
      .then(() => this.handleRequest(message))
      .catch((error) => {
        if (error?.code === 'CRUISE_APPROVAL_CHANNEL_UNAVAILABLE') this.pending?.reject(error);
        return this.client.respondError(message.id, error);
      });
  }

  async handleRequest(message) {
    if (this.stopping) return;
    let result;
    if (message.method === 'item/tool/requestUserInput') {
      const answers = {};
      const unresolved = [];
      const evidence = { nativeApprovalDenied: this.turnNativeApprovalDenied };
      for (const question of message.params?.questions ?? []) {
        const params = { questions: [question] };
        const automatic = this.skill === 'goal'
          ? automaticGoalProgress(params, evidence)
          : automaticDelegationAuthorization(params, evidence);
        if (automatic) Object.assign(answers, automatic.answers);
        else unresolved.push(question);
      }
      if (unresolved.length) {
        const requested = await this.awaitHumanInput(() => answerUserInput({ questions: unresolved }, {
          pickOne: this.pickOne,
          readLine: this.readLine,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
        }));
        Object.assign(answers, requested.answers);
      }
      result = { answers };
    } else if ([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
    ].includes(message.method)) {
      const automatic = message.method === 'item/commandExecution/requestApproval'
        ? automaticMigrationCommandApproval(message.params)
        : null;
      const decision = automatic ?? await this.awaitHumanInput(() => answerApproval(message.params, {
          pickOne: this.pickOne,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
        }));
      if (
        (decision === 'decline' || decision === 'cancel')
        && message.params?.threadId === this.threadId
        && message.params?.turnId === this.turnId
      ) this.turnNativeApprovalDenied = true;
      result = message.method === 'item/permissions/requestApproval'
        ? { permissions: decision === 'accept' ? message.params.permissions ?? {} : {}, scope: 'turn' }
        : { decision };
    } else if (message.method === 'currentTime/read') {
      result = { currentTimeAt: Math.floor(Date.now() / 1000) };
    } else {
      this.client.respondError(message.id, -32601, `Cruise does not support ${message.method}`);
      return;
    }
    this.client.respond(message.id, result);
  }

  async awaitHumanInput(callback) {
    this.client.pauseInactivityWatchdog?.();
    try {
      return await callback();
    } finally {
      this.client.resumeInactivityWatchdog?.();
    }
  }

  handleNotification(message) {
    const params = message.params ?? {};
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (message.method === 'error') {
      if (params.willRetry === false && this.pending && !this.settledTurnIds.has(params.turnId)
        && (!this.turnId || this.turnId === params.turnId)) {
        this.pending.reject(new Error(params.error?.message ?? 'Codex reported a nonretrying protocol error.'));
      }
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      try {
        this.usageMeter.consume(params, { model: this.threadModel });
        this.compactionController.observeUsage(params.threadId);
        this.scheduleUsagePersistence();
      } catch (error) {
        this.errorOutput.write(
          `Cruise warning: invalid token usage notification: ${String(error?.message ?? error).replace(/\s+/gu, ' ').trim()}.\n`,
        );
      }
      return;
    }
    if (this.compactionController.handleNotification(message)) return;
    if (message.method === 'item/autoApprovalReview/completed') {
      // Only host protocol evidence for this turn can suppress recovery. Replayed
      // reviews from earlier turns and agent prose are not native decisions.
      if (
        params.threadId === this.threadId
        && typeof params.turnId === 'string'
        && params.turnId === this.turnId
        && params.review?.status === 'denied'
      ) {
        this.turnNativeApprovalDenied = true;
      }
    } else if (message.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      this.output.write(delta);
      if (this.skill === 'goal' && this.turnAgentText.length < MAX_TURN_AGENT_TEXT) {
        this.turnAgentText += delta.slice(0, MAX_TURN_AGENT_TEXT - this.turnAgentText.length);
      }
    } else if (message.method === 'turn/started') {
      this.retryTraceAfterTurnStart();
      if (
        this.pending &&
        this.turnId === null &&
        params.turn?.id &&
        !this.settledTurnIds.has(params.turn.id) &&
        (!this.nativeGoalTurnWaiting || !this.nativeGoalTurnTimedOut)
      ) {
        if (this.nativeGoalTurnWaiting) {
          this.nativeGoalTurnStarted = true;
          this.clearNativeGoalTurnDeadline();
        }
        this.turnId = params.turn.id;
        this.resolveEarlyTurnResult(params.turn.id);
      }
    } else if (message.method === 'turn/completed') {
      this.settleTurn(params.turn?.id, { turn: params.turn });
    } else if (message.method === 'turn/failed') {
      this.settleTurn(params.turn?.id, {
        error: new Error(params.turn?.error?.message ?? 'Cruise turn failed.'),
      });
    } else if (message.method === 'thread/goal/updated' && params.goal) {
      this.goal = params.goal;
    }
  }

  handleExit(info = {}) {
    if (!this.stopping) {
      const error = info.error ?? new Error(`Codex app-server exited (${info.code ?? 'unknown'}).`);
      this.clearNativeGoalTurnDeadline();
      this.startupAbortController.abort(error);
      this.cancelNativeGoalCleanup(error);
      this.pending?.reject(error);
    }
  }
}
