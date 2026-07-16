import { EventEmitter } from 'node:events';

import {
  answerApprovalRequest,
  answerUserInputRequest,
} from './interaction.mjs';
import {
  cruiseClassInstructions,
  resolveNativeCruiseHost,
} from './cruise-class.mjs';
import { communicationStyleInstructions } from './communication-style.mjs';
import {
  UserFacingMessageBuffer,
  userFacingError,
  xmlPrompt,
} from './user-facing-output.mjs';

const WORKFLOW_PHASES = Object.freeze({
  build: Object.freeze([
    Object.freeze({ name: 'capture', mode: 'default' }),
    Object.freeze({ name: 'clarify', mode: 'plan' }),
    Object.freeze({ name: 'draft', mode: 'default' }),
    Object.freeze({ name: 'approval', mode: 'plan' }),
    Object.freeze({ name: 'finalize', mode: 'default' }),
  ]),
  refine: Object.freeze([
    Object.freeze({ name: 'capture', mode: 'default' }),
    Object.freeze({ name: 'clarify', mode: 'plan' }),
    Object.freeze({ name: 'draft', mode: 'default' }),
    Object.freeze({ name: 'approval', mode: 'plan' }),
    Object.freeze({ name: 'execute', mode: 'default' }),
  ]),
  quick: Object.freeze([
    Object.freeze({ name: 'capture', mode: 'default' }),
    Object.freeze({ name: 'clarify', mode: 'plan' }),
    Object.freeze({ name: 'execute', mode: 'default' }),
  ]),
  debug: Object.freeze([
    Object.freeze({ name: 'capture', mode: 'default' }),
    Object.freeze({ name: 'clarify', mode: 'plan' }),
    Object.freeze({ name: 'execute', mode: 'default' }),
  ]),
  research: Object.freeze([
    Object.freeze({ name: 'capture', mode: 'default' }),
    Object.freeze({ name: 'clarify', mode: 'plan' }),
    Object.freeze({ name: 'execute', mode: 'default' }),
  ]),
});

const PHASE_INSTRUCTIONS = Object.freeze({
  capture: `Capture the immutable Cruise Origin and initialize the selected workflow. Run readiness
checks and the runtime begin step, which activates non-destructive foreign-diff monitoring
automatically. Do not ask a speculative repository-change or permission question. Do not do
substantive work in this phase, and do not ask the user a question.`,
  clarify: `This is a read-only clarification phase. Inspect the captured request and only the bounded
evidence needed to find material ambiguity. Ask one concise question at a time only when its answer
would change the result or permission envelope. There is no minimum question count. If the request
is already actionable, ask nothing and end the phase. Never ask how to handle hypothetical or
unexpected repository changes; the runtime pauses on a concrete drift incident if one occurs.`,
  draft: `Use the captured request and any answers already present in this thread. Persist the selected
workflow's draft artifacts and decisions. Do not ask questions in this write-capable phase. Stop at
the workflow's review boundary without treating a draft as approved.`,
  approval: `This is a read-only review phase. Present only the selected workflow's required approval
for the concrete draft. Do not repeat resolved questions and do not ask for hypothetical safety,
repository-drift, or mode decisions. If the workflow has no pending approval, end without asking.`,
  finalize: `Persist the review result and finish the Build workflow. Build may create or update only
its planning artifacts; it must not implement product changes. Do not ask the user to change Codex
modes or retry, and do not ask another question.`,
  execute: `Continue the selected workflow in Default mode using the captured request, material answers,
and any approved draft. Persist required control state and perform only the workflow-authorized
work. Do not ask the user to change Codex modes or retry. On resume, run the canonical
foreign-diff check once before reading or presenting any persisted incident; this retires legacy
noise-only pauses and erases their incident history after auto-clearing the disposable artifacts.
If a real product incident remains, stop and report its exact product paths.
Host metadata,
disposable caches, and other paths excluded by the canonical repository-scope policy are never an
incident: do not mention them, ask about them, or include them in status and change summaries.`,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function write(output, value) {
  output.write(String(value));
}

function writeLine(output, value = '') {
  write(output, `${value}\n`);
}

function validatePrompt(prompt) {
  const value = String(prompt ?? '');
  if (value.length === 0) throw new TypeError('Cruise requires a non-empty request.');
  return value;
}

function phasesFor(skill) {
  const phases = WORKFLOW_PHASES[skill];
  if (!phases) throw new TypeError(`Cruise has no staged workflow for ${skill}.`);
  return phases;
}

export function phasePrompt({ skill, phase, prompt, cwd }) {
  const system = [
    `Continue the same $cruise:${skill} run in its ${phase.name} phase.`,
    PHASE_INSTRUCTIONS[phase.name],
    `The repository root is ${cwd}. Keep using this same app-server thread and the existing Cruise run; never create a fresh run merely because the collaboration mode changed.`,
  ].join('\n');
  return xmlPrompt({ system, user: prompt });
}

function collaborationMode({ mode, model, reasoningEffort, developerInstructions }) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Codex did not report the thread model required for collaboration-mode switching.');
  }
  return {
    mode,
    settings: {
      model,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      developer_instructions: developerInstructions,
    },
  };
}

function sandboxFor(mode, cwd) {
  if (mode === 'plan') return { type: 'readOnly' };
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function cruiseWorkflowPhases(skill) {
  return phasesFor(skill).map((phase) => ({ ...phase }));
}

/**
 * Runs non-Goal Cruise skills in one persistent Codex thread while the client,
 * rather than the user or model, owns every collaboration-mode transition.
 */
export class CruiseSkillSession extends EventEmitter {
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
    cruiseClass = null,
    communicationStyle = null,
  }) {
    super();
    if (!client) throw new TypeError('client is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (!skillPath) throw new TypeError('skillPath is required');
    if (typeof pickOne !== 'function') throw new TypeError('pickOne is required');
    if (typeof readLine !== 'function') throw new TypeError('readLine is required');
    this.client = client;
    this.cwd = cwd;
    this.prompt = validatePrompt(prompt);
    this.skill = skill;
    this.skillPath = skillPath;
    this.pickOne = pickOne;
    this.readLine = readLine;
    this.lineReader = lineReader;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.cruiseClass = cruiseClass;
    this.communicationStyle = communicationStyle;
    this.threadId = null;
    this.turnId = null;
    this.phase = 'idle';
    this.mode = null;
    this._turns = new Map();
    this._earlyTurnCompletions = new Map();
    this._interactionTail = Promise.resolve();
    this._interrupted = false;
    this._stopping = false;
    this._agentMessages = new UserFacingMessageBuffer({
      output: this.output,
      style: this.communicationStyle?.style,
    });
    this._boundRequest = (message) => this._enqueueRequest(message);
    this._boundNotification = (message) => this._handleNotification(message);
    this._boundStderr = () => {};
    this._boundExit = (info) => this._handleExit(info);
    phasesFor(skill);
  }

  async run() {
    this._attach();
    try {
      await this.client.start();
      const hostSelection = this.cruiseClass === null
        ? null
        : resolveNativeCruiseHost(
            this.cruiseClass,
            await this.client.request('model/list', { limit: 100 }),
          );
      const started = await this.client.request('thread/start', {
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ...(hostSelection
          ? {
              model: hostSelection.model,
              allowProviderModelFallback: false,
              developerInstructions: [
                cruiseClassInstructions(this.cruiseClass, { nativeHost: true }),
                communicationStyleInstructions(this.communicationStyle),
              ].join('\n\n'),
            }
          : {}),
        serviceName: 'cruise_cli',
        ephemeral: false,
      });
      this.threadId = started.thread.id;
      const model = hostSelection?.model ?? started.model ?? started.thread?.model;
      const reasoningEffort = hostSelection?.reasoning_effort
        ?? started.reasoningEffort
        ?? started.thread?.reasoningEffort
        ?? null;
      this._writeStatus('Working session started.');

      for (const phase of phasesFor(this.skill)) {
        this._throwIfInterrupted();
        await this._runPhase(phase, { model, reasoningEffort });
      }
      await this._interactionTail;
      this.phase = 'complete';
      return { status: 'complete', skill: this.skill, threadId: this.threadId };
    } finally {
      this._stopping = true;
      await this._interactionTail.catch(() => {});
      await this.client.stop().catch(() => {});
      this._detach();
    }
  }

  async interrupt() {
    if (this._interrupted || this._stopping) return;
    this._interrupted = true;
    this.lineReader?.cancel?.('ctrl-c');
    if (this.threadId && this.turnId) {
      await this.client.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      }).catch(() => {});
    }
    const error = new Error('Cruise was interrupted.');
    error.name = 'CruiseInterruptedError';
    error.code = 'CRUISE_INTERRUPTED';
    for (const pending of this._turns.values()) pending.reject(error);
    this._turns.clear();
  }

  async _runPhase(phase, { model, reasoningEffort }) {
    this.phase = phase.name;
    this.mode = phase.mode;
    const instructions = PHASE_INSTRUCTIONS[phase.name];
    const sandboxPolicy = sandboxFor(phase.mode, this.cwd);
    // Plan mode remains read-only, but native Codex keeps control of any
    // approval it needs instead of Cruise silently declining it.
    const approvalPolicy = 'on-request';
    const mode = collaborationMode({
      mode: phase.mode,
      model,
      reasoningEffort,
      developerInstructions: [
        instructions,
        ...(this.cruiseClass === null
          ? []
          : [cruiseClassInstructions(this.cruiseClass, { nativeHost: true })]),
        communicationStyleInstructions(this.communicationStyle),
      ].join('\n\n'),
    });

    await this.client.request('thread/settings/update', {
      threadId: this.threadId,
      cwd: this.cwd,
      approvalPolicy,
      sandboxPolicy,
      collaborationMode: mode,
    });
    this._throwIfInterrupted();

    const turn = await this.client.request('turn/start', {
      threadId: this.threadId,
      input: [
        { type: 'skill', name: this.skill, path: this.skillPath },
        {
          type: 'text',
          text: phasePrompt({
            skill: this.skill,
            phase,
            prompt: this.prompt,
            cwd: this.cwd,
          }),
          text_elements: [],
        },
      ],
      cwd: this.cwd,
      runtimeWorkspaceRoots: [],
      model,
      ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      sandboxPolicy,
      approvalPolicy,
      collaborationMode: mode,
      responsesapiClientMetadata: {
        cruise_skill: this.skill,
        cruise_phase: phase.name,
      },
    });
    this.turnId = turn.turn.id;
    const completion = deferred();
    this._turns.set(this.turnId, completion);
    const early = this._earlyTurnCompletions.get(this.turnId);
    if (early) {
      this._earlyTurnCompletions.delete(this.turnId);
      if (early.error) completion.reject(early.error);
      else completion.resolve(early.turn);
    }
    const result = await completion.promise;
    this._turns.delete(this.turnId);
    await this._interactionTail;
    if (result.status !== 'completed') {
      throw new Error(`Cruise ${this.skill} ${phase.name} ended with status ${result.status}.`);
    }
  }

  _throwIfInterrupted() {
    if (!this._interrupted) return;
    const error = new Error('Cruise was interrupted.');
    error.name = 'CruiseInterruptedError';
    error.code = 'CRUISE_INTERRUPTED';
    throw error;
  }

  _writeStatus(value) {
    const safe = userFacingError(value, { style: this.communicationStyle?.style });
    if (safe) writeLine(this.errorOutput, safe);
  }

  _attach() {
    this.client.on('request', this._boundRequest);
    this.client.on('notification', this._boundNotification);
    this.client.on('stderr', this._boundStderr);
    this.client.on('exit', this._boundExit);
  }

  _detach() {
    this.client.off?.('request', this._boundRequest);
    this.client.off?.('notification', this._boundNotification);
    this.client.off?.('stderr', this._boundStderr);
    this.client.off?.('exit', this._boundExit);
  }

  _enqueueRequest(message) {
    this._interactionTail = this._interactionTail
      .then(() => this._handleRequest(message))
      .catch((error) => {
        this.client.respondError(message.id, error);
        this._writeStatus(`Cruise interaction failed: ${error.message}`);
      });
  }

  async _handleRequest(message) {
    if (this._stopping) return;
    let result;
    switch (message.method) {
      case 'item/tool/requestUserInput':
        result = (await answerUserInputRequest(message.params, {
          pickOne: this.pickOne,
          readLine: this.readLine,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
          communicationStyle: this.communicationStyle?.style,
        })).result;
        break;
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const decision = await answerApprovalRequest(message.params, {
          pickOne: this.pickOne,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
          availableDecisions: message.params.availableDecisions,
          communicationStyle: this.communicationStyle?.style,
        });
        result = { decision };
        break;
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const decision = await answerApprovalRequest(message.params, {
          pickOne: this.pickOne,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
          communicationStyle: this.communicationStyle?.style,
        });
        result = {
          decision: decision === 'accept'
            ? 'approved'
            : decision === 'acceptForSession'
              ? 'approved_for_session'
              : decision === 'cancel'
                ? 'abort'
                : 'denied',
        };
        break;
      }
      case 'item/permissions/requestApproval': {
        const decision = await answerApprovalRequest(message.params, {
          pickOne: this.pickOne,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
          availableDecisions: ['accept', 'decline'],
          communicationStyle: this.communicationStyle?.style,
        });
        const requested = message.params.permissions ?? {};
        const granted = {};
        if (requested.network != null) granted.network = requested.network;
        if (requested.fileSystem != null) granted.fileSystem = requested.fileSystem;
        result = {
          permissions: decision === 'accept' ? granted : {},
          scope: 'turn',
        };
        break;
      }
      case 'mcpServer/elicitation/request': {
        const decision = await answerApprovalRequest(message.params, {
          pickOne: this.pickOne,
          input: this.input,
          output: this.errorOutput,
          lineReader: this.lineReader,
          availableDecisions: ['accept', 'decline'],
          communicationStyle: this.communicationStyle?.style,
        });
        result = {
          action: decision === 'accept' ? 'accept' : 'decline',
          content: null,
          _meta: null,
        };
        break;
      }
      case 'currentTime/read':
        result = { currentTimeAt: Math.floor(Date.now() / 1000) };
        break;
      default:
        this.client.respondError(message.id, -32601, `Cruise does not support ${message.method}`);
        return;
    }
    this.client.respond(message.id, result);
  }

  _handleNotification(message) {
    const { method, params = {} } = message;
    if (method === 'item/agentMessage/delta') {
      this._agentMessages.append(params.delta);
      return;
    }
    if (method === 'turn/completed') {
      this._agentMessages.flush();
      const pending = this._turns.get(params.turn?.id);
      if (pending) pending.resolve(params.turn);
      else this._earlyTurnCompletions.set(params.turn?.id, { turn: params.turn });
      return;
    }
    if (method === 'turn/failed') {
      this._agentMessages.flush();
      const pending = this._turns.get(params.turn?.id);
      const error = new Error(params.turn?.error?.message ?? 'Cruise turn failed.');
      if (pending) pending.reject(error);
      else this._earlyTurnCompletions.set(params.turn?.id, { error });
    }
  }

  _handleExit(info) {
    if (this._stopping) return;
    this._agentMessages.flush();
    const error = new Error(`Codex app-server exited before Cruise completed (${info?.code ?? 'unknown'}).`);
    for (const pending of this._turns.values()) pending.reject(error);
    this._turns.clear();
  }
}
