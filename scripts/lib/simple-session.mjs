import { EventEmitter } from 'node:events';

import {
  DEFAULT_STALL,
  flightPlanTemplate,
  inspectFlightPlan,
} from './flight-plan.mjs';
import {
  captureWorkspaceFingerprint,
  extractFailureSignature,
  GoalSupervisor,
  writeCruiseScratchJson,
  writeSupervisorState,
} from './supervisor.mjs';
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
const GOAL_AUTHORIZATION_OPTION = /^\s*(?:approve(?:\s+(?:both|the\s+(?:plan|goal|contract)|[a-z]+-?\d+\s+contract))?|start\s+cruise|continue|proceed|execute|implement)\b/iu;
const HIGH_RISK_GOAL_AUTHORIZATION = /\b(?:credential|secret|password|token|authentication|login|payment|purchase|production|deploy|publish|release|delete|remove|reset|rewrite|force|sudo|sensitive|private\s+data)\b/iu;
const MATERIAL_GOAL_DECISION = /\b(?:not\s+requested|out(?:side)?\s+(?:the\s+)?scope|scope\s+(?:change|expansion)|which\s+(?:option|approach)|user\s+preference)\b/iu;

const AUTONOMOUS_GOAL_INSTRUCTIONS = [
  'The user explicitly invoked Cruise Goal, which authorizes autonomous end-to-end progress within the normal Codex workspace and permission boundaries.',
  'Use the first read-only Plan turn only to inspect the repository, resolve the outcome, touchpoints, non-goals, invariants, acceptance commands, and stall tuning, and form a strongly aligned plan for the first ready micro-goal. Unless the user explicitly requested planning or research only, that plan is not an endpoint: the following native Goal turn must immediately implement it and write the advisory .cruise/FLIGHT.md as its first execution act.',
  'For every micro-goal, reread and reconcile the user-editable flight plan with the requested outcome and current repository evidence; realign before work outside its touchpoints or inside its non-goals; re-verify affected invariants; make a compact plan for the next ready slice; implement it; run focused verification; remediate in-scope failures; recheck alignment and regression risk; then immediately execute the next ready micro-goal.',
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
  'Write .cruise/FLIGHT.md first if execution has not created it yet, then reread and reconcile its user-editable outcome, scope fence, invariants, acceptance commands, and stall tuning with current repository evidence, completed work, and remaining criteria.',
  'Draft only a compact, codebase-aware plan for the next ready micro-goal, then immediately implement it and run focused verification.',
  'Remediate in-scope failures, recheck alignment and regression risk, use bounded independent breakage probes when the change warrants them, and continue until the flight plan and Goal are truthfully complete or both report a concrete material blocker.',
  'Routine micro-goal progression is already authorized; do not ask the user for a phase or plan approval.',
].join(' ');

const MAX_TURN_AGENT_TEXT = 64 * 1024;
export const DEFAULT_FIRST_TURN_DEADLINE_MS = 120_000;
const DEFAULT_FIRST_TURN_CLEANUP_DEADLINE_MS = 2_000;

function formatDuration(milliseconds) {
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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
export function automaticGoalAuthorization(params = {}) {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) return null;

  const answers = {};
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const visible = [
      question?.header ?? '',
      question?.question ?? '',
      ...options.map(optionLabel),
    ].join(' ');
    if (
      typeof question?.id !== 'string' ||
      question.id.length === 0 ||
      !GOAL_AUTHORIZATION_CONTEXT.test(visible) ||
      HIGH_RISK_GOAL_AUTHORIZATION.test(visible) ||
      MATERIAL_GOAL_DECISION.test(visible)
    ) {
      return null;
    }
    const choice = options.find((option) => GOAL_AUTHORIZATION_OPTION.test(optionLabel(option)));
    const value = optionValue(choice);
    if (value === null) return null;
    answers[question.id] = { answers: [String(value)] };
  }
  return { answers };
}

export function automaticGoalProgress(params = {}) {
  return automaticRoutineGoalAdvance(params) ?? automaticGoalAuthorization(params);
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

async function answerApproval(params, { pickOne, input, output, lineReader }) {
  const selection = await pickOne({
    title: params.reason ?? params.command ?? 'Approve this action?',
    options: (params.availableDecisions ?? ['accept', 'decline']).map((value) => ({
      label: String(value),
      value,
    })),
    input,
    output,
    lineReader,
  });
  return selectionValue(selection) ?? 'decline';
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
    output = process.stdout,
    errorOutput = process.stderr,
    supervisor = new GoalSupervisor(),
    captureFingerprint = captureWorkspaceFingerprint,
    readPlan = inspectFlightPlan,
    firstTurnDeadlineMs = DEFAULT_FIRST_TURN_DEADLINE_MS,
    firstTurnCleanupDeadlineMs = DEFAULT_FIRST_TURN_CLEANUP_DEADLINE_MS,
    locateTrace = locateRollout,
    traceHome = codexHome(),
    clock = () => new Date(),
  }) {
    super();
    if (!client || !cwd || !prompt || !skill || !skillPath) {
      throw new TypeError('client, cwd, prompt, skill, and skillPath are required');
    }
    this.client = client;
    this.cwd = cwd;
    this.prompt = prompt;
    this.skill = skill;
    this.skillPath = skillPath;
    this.goalPreparationOnly = skill === 'goal' && isPreparationOnlyGoalPrompt(prompt);
    this.pickOne = pickOne;
    this.readLine = readLine;
    this.lineReader = lineReader;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.supervisor = supervisor;
    this.captureFingerprint = captureFingerprint;
    this.readPlan = readPlan;
    this.supervisorFlightHash = 'absent';
    this.firstTurnDeadlineMs = firstTurnDeadlineMs;
    this.firstTurnCleanupDeadlineMs = firstTurnCleanupDeadlineMs;
    this.locateTrace = locateTrace;
    this.traceHome = traceHome;
    this.clock = clock;
    this.runStartedAt = null;
    this.runFinalStatus = 'failed';
    this.rolloutPath = null;
    this.traceLookup = Promise.resolve();
    this.traceRetryStarted = false;
    this.turnAgentText = '';
    this.threadId = null;
    this.threadModel = null;
    this.threadReasoningEffort = null;
    this.turnId = null;
    this.pending = null;
    this.earlyTurnResults = new Map();
    this.nativeGoalTurnDeadline = null;
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
  }

  async run() {
    this.runStartedAt = this.timestamp();
    this.client.on('request', this.onRequest);
    this.client.on('notification', this.onNotification);
    this.client.on('exit', this.onExit);
    try {
      await this.client.start();
      if (this.skill === 'goal') this.errorOutput.write('Cruise: app-server started.\n');
      const started = await this.client.request('thread/start', {
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        serviceName: 'cruise',
        ephemeral: false,
        developerInstructions: [
          'Work directly with the user request and the repository.',
          'Cruise keeps .cruise/ORIGIN.md as a verbatim request note; Goal work may also maintain the user-editable advisory .cruise/FLIGHT.md.',
          'Do not create Cruise run-control files, approval digests, archives, or YAML workflow state. FLIGHT.md frontmatter is an advisory note, not workflow authority.',
          'Use normal Codex approvals and report failures factually.',
          ...(this.skill === 'goal' ? [AUTONOMOUS_GOAL_INSTRUCTIONS] : []),
        ].join(' '),
      });
      this.threadId = started.thread.id;
      this.threadModel = started.model ?? null;
      this.threadReasoningEffort = started.reasoningEffort ?? null;
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
        try {
          await this.activateGoal();
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
      while (this.skill === 'goal') {
        await this.interactions;
        if (result.status !== 'completed') {
          throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
        }
        const goal = await this.refreshGoal();
        if (TERMINAL_GOAL_STATUSES.has(goal?.status)) {
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
        let continuationInstructions = GOAL_CONTINUATION_INSTRUCTIONS;
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
          if (verdict.level === 'corrective') continuationInstructions = correctiveFlightInstructions(verdict.reason);
          else if (verdict.level === 'realign') continuationInstructions = realignmentInstructions(verdict.reason);
          else if (verdict.level === 'final-experiment') continuationInstructions = finalExperimentInstructions(verdict.reason);
        }
        if (!goalExecutionMode) {
          await this.updateGoalMode('default');
          goalExecutionMode = true;
        }
        result = await this.startTurn([
          {
            type: 'text',
            text: continuationInstructions,
            text_elements: [],
          },
        ], { mode: 'default' });
        continuationCompleted = true;
      }
      await this.interactions;
      if (result.status !== 'completed') {
        throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
      }
      return this.finishResult({ status: 'complete', skill: this.skill, threadId: this.threadId });
    } catch (error) {
      this.runFinalStatus = this.interrupted
        ? 'interrupted'
        : error?.code === 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT'
          ? 'bootstrap-timeout'
          : 'failed';
      throw error;
    } finally {
      this.stopping = true;
      this.client.off?.('request', this.onRequest);
      this.client.off?.('notification', this.onNotification);
      this.client.off?.('exit', this.onExit);
      await this.traceLookup.catch(() => {});
      if (this.threadId) {
        await this.persistRunPointer({
          finalStatus: this.runFinalStatus,
          endedAt: this.timestamp(),
        });
        this.printClosingTraceSignpost();
      }
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
      await writeCruiseScratchJson(this.cwd, 'LAST-RUN.json', {
        thread_id: this.threadId,
        rollout_path: this.rolloutPath,
        cwd: this.cwd,
        skill: this.skill,
        started_at: this.runStartedAt,
        ended_at: endedAt,
        final_status: finalStatus,
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
    const objective = [
      `Autonomously complete the user's Cruise Goal: ${this.prompt}`,
      GOAL_BOOTSTRAP_INSTRUCTIONS,
      'Use each codebase-aware plan to launch the next ready micro-goal, then implement, verify, realign, and continue without routine phase approvals.',
    ].join(' ');
    const activated = await this.client.request('thread/goal/set', {
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

  goalTurnSettings(mode) {
    const collaborationMode = { mode };
    if (this.threadModel) {
      collaborationMode.settings = {
        model: this.threadModel,
        ...(this.threadReasoningEffort
          ? { reasoning_effort: this.threadReasoningEffort }
          : {}),
        developer_instructions: AUTONOMOUS_GOAL_INSTRUCTIONS,
      };
    }
    return {
      collaborationMode,
      sandboxPolicy: mode === 'plan'
        ? { type: 'readOnly' }
        : { type: 'workspaceWrite', writableRoots: [this.cwd] },
    };
  }

  async updateGoalMode(mode) {
    const settings = this.goalTurnSettings(mode);
    await this.client.request('thread/settings/update', {
      threadId: this.threadId,
      cwd: this.cwd,
      approvalPolicy: 'on-request',
      ...settings,
    });
  }

  async startTurn(input, { mode = null } = {}) {
    this.turnAgentText = '';
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
        ...(goalSettings ?? {
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd] },
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
    if (this.nativeGoalTurnDeadline !== null) {
      clearTimeout(this.nativeGoalTurnDeadline);
      this.nativeGoalTurnDeadline = null;
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

  async waitForNativeGoalTurn(goalActivated = Promise.resolve()) {
    const completion = deferred();
    this.turnId = null;
    this.pending = completion;
    this.nativeGoalTurnWaiting = true;
    this.nativeGoalTurnStarted = false;
    this.nativeGoalTurnTimedOut = false;
    this.nativeGoalCleanupCancelled = null;
    try {
      await goalActivated;
      if (!this.nativeGoalTurnStarted && this.pending === completion) {
        const startedAt = Date.now();
        this.nativeGoalTurnDeadline = setTimeout(() => {
          this.nativeGoalTurnDeadline = null;
          void this.expireNativeGoalTurnDeadline(completion, startedAt);
        }, this.firstTurnDeadlineMs);
      }
      return await completion.promise;
    } finally {
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
    this.turnId = null;
    if (early.error) this.pending.reject(early.error);
    else this.pending.resolve(early.turn);
  }

  settleTurn(turnId, { turn = null, error = null } = {}) {
    if (!this.pending || !turnId) return;
    if (this.turnId === null) {
      this.earlyTurnResults.set(turnId, { turn, error });
      return;
    }
    if (turnId !== this.turnId) return;
    this.turnId = null;
    if (error) this.pending.reject(error);
    else this.pending.resolve(turn);
  }

  async interrupt() {
    this.interrupted = true;
    this.clearNativeGoalTurnDeadline();
    const interruption = new SimpleCruiseInterruptedError();
    this.cancelNativeGoalCleanup(interruption);
    this.pending?.reject(interruption);
    this.client.interrupt?.();
    this.lineReader?.cancel?.('ctrl-c');
    if (this.threadId && this.turnId) {
      await this.client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      }).catch(() => {});
    }
    await this.pauseActiveGoal().catch(() => {});
  }

  async pauseActiveGoal() {
    if (!this.threadId) return;
    const current = this.goal ?? (await this.client.request('thread/goal/get', {
      threadId: this.threadId,
    })).goal;
    if (current?.status !== 'active') return;
    const paused = await this.client.request('thread/goal/set', {
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
    try {
      await writeSupervisorState(this.cwd, this.supervisor.state({
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
      .catch((error) => this.client.respondError(message.id, error));
  }

  async handleRequest(message) {
    if (this.stopping) return;
    let result;
    if (message.method === 'item/tool/requestUserInput') {
      result = this.skill === 'goal' ? automaticGoalProgress(message.params) : null;
      if (result === null) {
        result = await this.awaitHumanInput(() => answerUserInput(message.params, {
          pickOne: this.pickOne,
          readLine: this.readLine,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
        }));
      }
    } else if ([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
    ].includes(message.method)) {
      const decision = await this.awaitHumanInput(() => answerApproval(message.params, {
        pickOne: this.pickOne,
        input: this.input,
        output: this.errorOutput,
        lineReader: this.lineReader,
      }));
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
    if (message.method === 'item/agentMessage/delta') {
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
      this.cancelNativeGoalCleanup(error);
      this.pending?.reject(error);
    }
  }
}
