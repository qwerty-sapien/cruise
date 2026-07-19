import { EventEmitter } from 'node:events';

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
  'Use the first read-only Plan turn only to inspect the repository and form a codebase-aware, strongly aligned plan for the first ready micro-goal. Unless the user explicitly requested planning or research only, that plan is not an endpoint: the following native Goal turn must immediately implement it.',
  'For every micro-goal, reconcile the requested outcome and current repository evidence; make a compact plan for the next ready slice; implement it; run focused verification; remediate in-scope failures; recheck alignment and regression risk; then immediately execute the next ready micro-goal.',
  'When changed behavior has meaningful concurrency, lifecycle, migration, public-contract, security, integration, or edge-case risk, use available independent reviewers or a bounded agent swarm to try to break it. Give them non-overlapping probes, reproduce credible findings, and refine before advancing. Skip this for simple low-risk work and never claim independent coverage that did not run.',
  'Do not ask the user to approve a phase, checkpoint, plan handoff, or ordinary next step. Ask only for a material product decision that repository evidence cannot resolve, a scope or safety expansion, authentication or secret entry, or a host-required external or destructive approval.',
  'Do not mark the Goal paused or blocked merely because a phase ended or because a fresh continuation is needed. Cruise starts another turn automatically while the Goal remains active.',
  'Keep the native Goal active until every requested acceptance and verification criterion passes. Then mark it complete. Mark it blocked only for a concrete unresolved blocker and state the evidence needed to resume.',
].join(' ');

const GOAL_BOOTSTRAP_INSTRUCTIONS = [
  'Begin with this sole read-only Plan-mode bootstrap, not a plan-only handoff.',
  'Inspect the codebase and state a compact plan for the first ready, in-scope micro-goal.',
  'Do not implement in this Plan turn. Unless the request explicitly limits work to planning or research, switch to Default mode immediately afterward and implement and verify this micro-goal.',
].join(' ');

const GOAL_CONTINUATION_INSTRUCTIONS = [
  'Continue the active Cruise Goal now; this is execution, not a request for a new plan review.',
  'Reconcile the requested outcome, current repository evidence, completed work, and remaining acceptance criteria.',
  'Draft only a compact, codebase-aware plan for the next ready micro-goal, then immediately implement it and run focused verification.',
  'Remediate in-scope failures, recheck alignment and regression risk, use bounded independent breakage probes when the change warrants them, and continue until the Goal is truthfully complete or a concrete material blocker requires the user.',
  'Routine micro-goal progression is already authorized; do not ask the user for a phase or plan approval.',
].join(' ');


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
    this.threadId = null;
    this.threadModel = null;
    this.threadReasoningEffort = null;
    this.turnId = null;
    this.pending = null;
    this.earlyTurnResults = new Map();
    this.goal = null;
    this.interrupted = false;
    this.stopping = false;
    this.interactions = Promise.resolve();
    this.onRequest = (message) => this.enqueueRequest(message);
    this.onNotification = (message) => this.handleNotification(message);
    this.onExit = (info) => this.handleExit(info);
  }

  async run() {
    this.client.on('request', this.onRequest);
    this.client.on('notification', this.onNotification);
    this.client.on('exit', this.onExit);
    try {
      await this.client.start();
      const started = await this.client.request('thread/start', {
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        serviceName: 'cruise',
        ephemeral: false,
        developerInstructions: [
          'Work directly with the user request and the repository.',
          'Cruise keeps only .cruise/ORIGIN.md as a verbatim note of the request.',
          'Do not create Cruise run-control files, approval digests, archives, or YAML workflow artifacts.',
          'Use normal Codex approvals and report failures factually.',
          ...(this.skill === 'goal' ? [AUTONOMOUS_GOAL_INSTRUCTIONS] : []),
        ].join(' '),
      });
      this.threadId = started.thread.id;
      this.threadModel = started.model ?? null;
      this.threadReasoningEffort = started.reasoningEffort ?? null;

      let result;
      let goalExecutionMode = false;
      if (this.skill === 'goal') {
        await this.updateGoalMode('plan');
        const nativeTurn = this.waitForNativeGoalTurn();
        try {
          await this.activateGoal();
        } catch (error) {
          this.pending?.reject(error);
          await nativeTurn.catch(() => {});
          throw error;
        }
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
          return { status: goal.status, skill: this.skill, threadId: this.threadId, goal };
        }
        if (goal?.status !== 'active') {
          throw new Error(`Cruise Goal entered unsupported status ${String(goal?.status ?? 'missing')}.`);
        }
        if (this.goalPreparationOnly) {
          const completed = await this.completePreparedGoal(goal);
          return {
            status: completed.status,
            skill: this.skill,
            threadId: this.threadId,
            goal: completed,
          };
        }
        if (!goalExecutionMode) {
          await this.updateGoalMode('default');
          goalExecutionMode = true;
        }
        result = await this.startTurn([
          {
            type: 'text',
            text: GOAL_CONTINUATION_INSTRUCTIONS,
            text_elements: [],
          },
        ], { mode: 'default' });
      }
      await this.interactions;
      if (result.status !== 'completed') {
        throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
      }
      return { status: 'complete', skill: this.skill, threadId: this.threadId };
    } finally {
      this.stopping = true;
      this.client.off?.('request', this.onRequest);
      this.client.off?.('notification', this.onNotification);
      this.client.off?.('exit', this.onExit);
      await this.client.stop().catch(() => {});
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
    const completion = deferred();
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

  async waitForNativeGoalTurn() {
    const completion = deferred();
    this.turnId = null;
    this.pending = completion;
    try {
      return await completion.promise;
    } finally {
      if (this.pending === completion) {
        this.pending = null;
        this.earlyTurnResults.clear();
      }
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
    this.lineReader?.cancel?.('ctrl-c');
    if (this.threadId && this.turnId) {
      await this.client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      }).catch(() => {});
    }
    await this.pauseActiveGoal().catch(() => {});
    this.pending?.reject(new SimpleCruiseInterruptedError());
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
        result = await answerUserInput(message.params, {
          pickOne: this.pickOne,
          readLine: this.readLine,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
        });
      }
    } else if ([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
    ].includes(message.method)) {
      const decision = await answerApproval(message.params, {
        pickOne: this.pickOne,
        input: this.input,
        output: this.errorOutput,
        lineReader: this.lineReader,
      });
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

  handleNotification(message) {
    const params = message.params ?? {};
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (message.method === 'item/agentMessage/delta') {
      this.output.write(String(params.delta ?? ''));
    } else if (message.method === 'turn/started') {
      if (this.pending && this.turnId === null && params.turn?.id) {
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
      this.pending?.reject(new Error(`Codex app-server exited (${info.code ?? 'unknown'}).`));
    }
  }
}
