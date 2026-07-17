import { EventEmitter } from 'node:events';

const TERMINAL_GOAL_STATUSES = new Set([
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]);

const ROUTINE_PHASE_GATE = /\b(?:[ptm]-?\d+|phase\s*\d+|subtask\s*\d+|task\s*\d+|next\s+(?:step|phase|subtask)|ready\s+(?:to\s+)?(?:proceed|continue|advance))\b/iu;
const PROCEEDING_CHOICE = /^\s*(?:approve|proceed|continue|advance|resume|start)\b/iu;
const HIGH_RISK_CHOICE = /\b(?:credential|secret|password|token|authentication|login|payment|purchase|production|deploy|publish|release|delete|remove|reset|rewrite|force|sensitive|private\s+data)\b/iu;

const AUTONOMOUS_GOAL_INSTRUCTIONS = [
  'The user explicitly invoked Cruise Goal, which authorizes autonomous end-to-end progress within the normal Codex workspace and permission boundaries.',
  'After each subtask, evaluate its stated success and readiness criteria. When they pass, immediately execute the next ready in-scope subtask; do not ask the user to approve a phase, checkpoint, or ordinary next step.',
  'Do not mark the Goal paused or blocked merely because a phase ended or because a fresh continuation is needed. Cruise starts another turn automatically while the Goal remains active.',
  'Ask the user only for a material product decision that cannot be resolved from repository evidence, a scope or safety expansion, authentication or secret entry, or a host-required approval for an external or destructive effect.',
  'Keep the native Goal active until every requested acceptance and verification criterion passes. Then mark it complete. Mark it blocked only for a concrete unresolved blocker and state the evidence needed to resume.',
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
    const visible = [
      question?.header ?? '',
      question?.question ?? '',
      ...options.map(optionLabel),
    ].join(' ');
    if (!ROUTINE_PHASE_GATE.test(visible) || HIGH_RISK_CHOICE.test(visible)) return null;
    const choice = options.find((option) => PROCEEDING_CHOICE.test(optionLabel(option)));
    const value = optionValue(choice);
    if (typeof question?.id !== 'string' || question.id.length === 0 || value === null) return null;
    answers[question.id] = { answers: [String(value)] };
  }
  return { answers };
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
    this.pickOne = pickOne;
    this.readLine = readLine;
    this.lineReader = lineReader;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.threadId = null;
    this.turnId = null;
    this.pending = null;
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

      let result = await this.startTurn([
        { type: 'skill', name: this.skill, path: this.skillPath },
        {
          type: 'text',
          text: this.prompt,
          text_elements: [],
        },
      ]);
      while (this.skill === 'goal') {
        await this.interactions;
        if (result.status !== 'completed') {
          throw new Error(`Cruise ${this.skill} ended with status ${result.status}.`);
        }
        if (this.goal === null) {
          const nativeTurn = this.waitForNativeGoalTurn();
          try {
            await this.activateGoal();
          } catch (error) {
            this.pending?.reject(error);
            await nativeTurn.catch(() => {});
            throw error;
          }
          result = await nativeTurn;
          continue;
        }
        const goal = await this.refreshGoal();
        if (TERMINAL_GOAL_STATUSES.has(goal?.status)) {
          return { status: goal.status, skill: this.skill, threadId: this.threadId, goal };
        }
        if (goal?.status !== 'active') {
          throw new Error(`Cruise Goal entered unsupported status ${String(goal?.status ?? 'missing')}.`);
        }
        result = await this.startTurn([
          {
            type: 'text',
            text: [
              'Continue the active Cruise Goal now.',
              'Use the completed work and current repository evidence to evaluate every success and readiness criterion.',
              'Automatically execute the next ready subtask; the user has already authorized ordinary phase progression and must not be asked to approve it again.',
              'Keep going until the native Goal can truthfully be marked complete or a concrete material blocker requires the user.',
            ].join(' '),
            text_elements: [],
          },
        ]);
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
    const current = await this.client.request('thread/goal/get', { threadId: this.threadId });
    if (current?.goal) {
      throw new Error(`Cruise cannot replace the existing native Goal (${current.goal.status}).`);
    }
    const objective = `Autonomously complete the user's Cruise Goal: ${this.prompt}`;
    const activated = await this.client.request('thread/goal/set', {
      threadId: this.threadId,
      objective,
      status: 'active',
    });
    if (activated?.goal?.status !== 'active') {
      throw new Error('Codex did not confirm the native Goal as active.');
    }
    this.goal = activated.goal;
  }

  async refreshGoal() {
    const result = await this.client.request('thread/goal/get', { threadId: this.threadId });
    this.goal = result?.goal ?? null;
    return this.goal;
  }

  async startTurn(input) {
    const completion = deferred();
    this.pending = completion;
    try {
      const turn = await this.client.request('turn/start', {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd] },
      });
      this.turnId = turn.turn.id;
      return await completion.promise;
    } finally {
      if (this.pending === completion) this.pending = null;
    }
  }

  async waitForNativeGoalTurn() {
    const completion = deferred();
    this.pending = completion;
    try {
      return await completion.promise;
    } finally {
      if (this.pending === completion) this.pending = null;
    }
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
    this.pending?.reject(new SimpleCruiseInterruptedError());
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
      result = this.skill === 'goal' ? automaticRoutineGoalAdvance(message.params) : null;
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
    if (message.method === 'item/agentMessage/delta') {
      this.output.write(String(params.delta ?? ''));
    } else if (message.method === 'turn/started') {
      this.turnId = params.turn?.id ?? this.turnId;
    } else if (message.method === 'turn/completed') {
      this.pending?.resolve(params.turn);
    } else if (message.method === 'turn/failed') {
      this.pending?.reject(new Error(params.turn?.error?.message ?? 'Cruise turn failed.'));
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
