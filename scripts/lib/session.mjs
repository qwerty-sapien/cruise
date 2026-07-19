import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import {
  activateApprovedGoal,
  capturePlanGoalApproval,
  captureRepositoryBaseline,
  GoalActivationUncertainError,
  isGoalNeedsOptions,
  isPlanGoalReviewOptions,
  verifyPlanGoalApproval,
} from './goal-contract.mjs';
import { verifyBuildApproval } from './build-contract.mjs';
import {
  createMilestoneControllerInteractionBroker,
  establishMilestoneControllerAuthority,
  invalidateMilestoneControllerAuthority,
  invalidateMilestoneControllerInteractionBroker,
  milestoneControllerSelectionId,
} from './milestone-controller.mjs';
import { activateMilestoneControllerHost } from './milestone-controller-host.mjs';
import {
  answerApprovalRequest,
  answerUserInputRequest,
  formatGoalStatus,
} from './interaction.mjs';
import {
  cruiseClassInstructions,
  resolveNativeCruiseHost,
} from './cruise-class.mjs';
import { communicationStyleInstructions } from './communication-style.mjs';
import { renderCombinedPlanGoalPreview } from './plan-renderer.mjs';
import {
  UserFacingMessageBuffer,
  sanitizeUserFacingText,
  xmlPrompt,
} from './user-facing-output.mjs';

const TERMINAL_GOAL_STATUSES = new Set([
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]);

const HIGH_RISK_AUTO_APPROVAL = /\b(?:credential|secret|password|token|destructive|delete|remove|reset|rewrite|force|sudo|production|deploy|publish|release|purchase|payment|message|email|sensitive|private data)\b/iu;
const ROUTINE_GOAL_AUTHORIZATION = /\b(?:plan(?:\s+and\s+goal)?|goal|cruise|contract|phase|micro[-\s]?goal|next\s+(?:step|phase|micro[-\s]?goal))\b/iu;
const MATERIAL_GOAL_DECISION = /\b(?:not\s+requested|out(?:side)?\s+(?:the\s+)?scope|scope\s+(?:change|expansion)|which\s+(?:option|approach)|user\s+preference)\b/iu;

export const CRUISE_PREPARATION_INSTRUCTIONS = `
You are preparing a Cruise contract. You
may inspect the repository and may create or update planning artifacts only
under .cruise/goal/. Do not modify target repository files, start
implementation, or cause external effects before native Goal activation.

Use the attached Cruise Goal skill. The explicit Cruise Goal invocation already
authorizes ordinary in-scope planning and execution; derive routine autonomy
from that request. Do not ask for a Plan, Goal, contract, digest, phase, or
autonomy approval unless a concrete material product decision cannot be
resolved from repository evidence. Do not use autoResolutionMs. Preserve the exact triggering request in immutable
ORIGIN.yaml before deriving intent. Write and validate ORIGIN.yaml, SPEC.md,
DECISIONS.md, ALIGNMENT.md, PLAN.md, and GOAL.md before review. A native Codex
Plan item is best-effort and only available when the GUI host has explicitly
enabled Plan collaboration mode. Cruise owns the deterministic combined preview
and automatically validates its artifact snapshot before native Goal activation.
Never request a copied approval phrase or an approval choice for that routine
transition. A host-required approval for an external, destructive, sensitive,
or otherwise material effect remains a real approval.
Single-slice execution remains the default. Activate milestone-controller mode
only when the user explicitly supplied or selected an approved milestone-wide
handoff; never infer it from ROADMAP.md or the existence of Build artifacts. In
that case, validate the current approved project/milestone contract, phase DAG,
closed milestone blockers, and explicit permission/autonomy envelope; write
ctrl.yaml in .cruise/goal/ and keep all Build source artifacts
read-only. PLAN.md is then a hierarchical controller plan for just-in-time phase
planning, not one flat milestone implementation plan.
The client mechanically validates the Plan and Goal artifact snapshot plus the
repository baseline immediately before activation. Never edit a candidate
artifact after it is complete.

Remain the root coordinator. Delegate substantive planning, execution, and
verification by recommended level through the Cruise worker launcher. Supply
only the bounded task packet and selected level; persist the launcher-owned
receipt with the returned report. The root owns routing, questions, approvals,
integration, and native Goal activation; workers never authorize themselves.

The client—not the model—owns native Goal activation. After the candidate is
complete, make no further artifact or repository write; end this preparation
turn without calling create_goal or implementing. The client will recheck the
snapshot, switch the thread to Default mode, and set the persisted native Goal.
`.trim();

export const CRUISE_CLIENT_INSTRUCTIONS = CRUISE_PREPARATION_INSTRUCTIONS;

export class CruiseInterruptedError extends Error {
  constructor(message = 'Cruise was interrupted; any active Goal was paused.') {
    super(message);
    this.name = 'CruiseInterruptedError';
    this.code = 'CRUISE_INTERRUPTED';
  }
}

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    reject = (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

function write(output, value) {
  output.write(String(value));
}

function writeLine(output, value = '') {
  write(output, `${value}\n`);
}

function effectivePrompt(userPrompt) {
  const request = String(userPrompt ?? '');
  if (request.length === 0) {
    throw new TypeError('Cruise requires a non-empty request so ORIGIN.yaml can preserve actual triggering bytes.');
  }
  return request;
}

function preparationPrompt(
  userPrompt,
  repositoryRoot,
  planningDirectory,
  { milestoneControllerAvailable = false, nativePlanPresentation = false } = {},
) {
  const request = effectivePrompt(userPrompt);
  const controllerBoundary = milestoneControllerAvailable
    ? 'Only for an explicitly supplied or selected approved milestone-wide handoff, also write ctrl.yaml, validate its locked Build contract manifest, and keep the referenced project/milestone files read-only; never infer controller mode from ROADMAP.md.'
    : 'This installed terminal entrypoint has no persistent Build-approval resolver, so it is single-slice Goal only: do not offer Use Milestone Controller, do not write ctrl.yaml, and direct milestone-wide execution to ordinary Codex with the approved Build run still in scope.';
  const system = [
    'Use $cruise:goal, attached as the goal skill input, to prepare this work. Inspect the repository first, then compile the complete Plan and Goal. The explicit Cruise Goal invocation already authorizes ordinary in-scope planning and execution.',
    nativePlanPresentation
      ? 'This host has explicitly enabled experimental native Plan presentation. Produce one native Plan item containing Plan and Goal, but do not assume it rendered; Cruise will fall back unless the item is observed.'
      : 'This CLI host does not expose Codex native Plan presentation. Do not claim to create a native frame; Cruise will render the captured PLAN.md and GOAL.md revisions itself.',
    'Do not request Plan, Goal, contract, digest, or routine phase approval. When the candidate is complete, end the preparation turn; the client validates it and owns native Goal activation. Ask only when a material product decision cannot be resolved from repository evidence or a host requires approval for an external, destructive, or sensitive effect.',
    `The target repository root is ${repositoryRoot}. Your shell cwd is the isolated planning directory ${planningDirectory}; inspect the target with absolute paths or git -C, and write the Cruise artifacts as ORIGIN.yaml, SPEC.md, DECISIONS.md, ALIGNMENT.md, optional ROADMAP.md, PLAN.md, and GOAL.md directly in the current planning directory. Single-slice mode is the default. ${controllerBoundary}`,
    'ORIGIN.yaml origin.raw_prompt must contain the exact request bytes from the user section, with no trimming, wrapper text, or delimiter.',
  ].join('\n');
  return xmlPrompt({ system, user: request });
}

function replaceAnswer(result, questionId, message) {
  result.answers[questionId] = { answers: [message] };
}

function rejectedAnswer(questionId, message) {
  return { answers: { [questionId]: { answers: [message] } } };
}

async function ensurePlanningDirectory(repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const cruiseDirectory = join(root, '.cruise');
  const planningDirectory = join(cruiseDirectory, 'goal');
  for (const directory of [cruiseDirectory, planningDirectory]) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${directory} must be a real directory, not a symlink or file.`);
    }
  }
  const resolvedPlanning = await realpath(planningDirectory);
  if (
    resolvedPlanning !== planningDirectory ||
    !resolvedPlanning.startsWith(`${root}${sep}`)
  ) {
    throw new Error('Cruise planning directory resolved outside the repository.');
  }
  return { repositoryRoot: root, planningDirectory };
}

export class CruiseSession extends EventEmitter {
  constructor({
    client,
    cwd,
    prompt,
    skillPath,
    pickOne,
    readLine,
    lineReader = null,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    continuationGraceMs = 1_000,
    activationRpcTimeoutMs = 30_000,
    resolveBuildApproval = null,
    cruiseClass = null,
    communicationStyle = null,
    renderPlan = renderCombinedPlanGoalPreview,
    nativePlanPresentation = false,
    implicitGoalAuthorization = true,
  }) {
    super();
    if (!client) throw new TypeError('client is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (!skillPath) throw new TypeError('skillPath is required');
    if (typeof pickOne !== 'function') throw new TypeError('pickOne is required');
    if (typeof readLine !== 'function') throw new TypeError('readLine is required');
    if (resolveBuildApproval !== null && typeof resolveBuildApproval !== 'function') {
      throw new TypeError('resolveBuildApproval must be a function when provided');
    }

    this.client = client;
    this.cwd = cwd;
    this.planningDirectory = join(cwd, '.cruise', 'goal');
    this.prompt = prompt;
    this.originPrompt = effectivePrompt(prompt);
    this.skillPath = skillPath;
    this.pickOne = pickOne;
    this.readLine = readLine;
    this.lineReader = lineReader;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.continuationGraceMs = continuationGraceMs;
    this.activationRpcTimeoutMs = activationRpcTimeoutMs;
    this.resolveBuildApproval = resolveBuildApproval;
    this.cruiseClass = cruiseClass;
    this.communicationStyle = communicationStyle;
    this.renderPlan = renderPlan;
    this.nativePlanPresentation = nativePlanPresentation === true;
    this.implicitGoalAuthorization = implicitGoalAuthorization !== false;
    this.sessionId = `cruise-session-${randomUUID()}`;

    this.phase = 'idle';
    this.threadId = null;
    this.turnId = null;
    this.goalApproval = null;
    this.startRequested = false;
    this.activeGoal = null;
    this.initialBaseline = null;
    this.controllerAuthority = null;
    this.verifiedBuildApproval = null;
    this.controllerDriver = null;
    this._interactionBroker = null;
    this.lastDirectUserEventReceipt = null;

    this._agentMessages = new UserFacingMessageBuffer({
      output: this.output,
      style: this.communicationStyle?.style,
    });
    this._stopping = false;
    this._abortRequested = false;
    this._preparationDone = deferred();
    this._executionDone = deferred();
    this._interactionTail = Promise.resolve();
    this._resolvedRequestIds = new Set();
    this._pendingRequestIds = new Set();
    this._activeInteraction = null;
    this._activeTurnIds = new Set();
    this._turnGeneration = 0;
    this._executionTurnObserved = false;
    this._terminalGoal = null;
    this._threadStatus = null;
    this._continuationTimer = null;
    this._activationController = null;
    this._controllerDriverTransferred = false;
    this._nativePlanItemSeen = false;
    this.goalNeedsSelection = null;
    this.autoApproveRoutineToolUse = false;

    this._boundRequest = (message) => this._enqueueRequest(message);
    this._boundNotification = (message) => this._handleNotification(message);
    this._boundStderr = () => {};
    this._boundExit = (info) => this._handleExit(info);
  }

  async run() {
    this._attach();
    this.phase = 'starting';
    try {
      const safePaths = await ensurePlanningDirectory(this.cwd);
      this.cwd = safePaths.repositoryRoot;
      this.planningDirectory = safePaths.planningDirectory;
      this.initialBaseline = captureRepositoryBaseline(this.cwd);
      await this.client.start();
      this._throwIfAborted();
      const hostSelection = this.cruiseClass === null
        ? null
        : resolveNativeCruiseHost(
            this.cruiseClass,
            await this.client.request('model/list', { limit: 100 }),
          );
      const threadStart = await this.client.request('thread/start', {
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        ...(hostSelection
          ? {
              model: hostSelection.model,
              allowProviderModelFallback: false,
            }
          : {}),
        developerInstructions: [
          ...(this.cruiseClass === null
            ? []
            : [cruiseClassInstructions(this.cruiseClass, { nativeHost: true })]),
          communicationStyleInstructions(this.communicationStyle),
        ].join('\n\n'),
        serviceName: 'cruise_cli',
        ephemeral: false,
      });
      this._throwIfAborted();

      this.threadId = threadStart.thread.id;
      const threadModel = hostSelection?.model ?? threadStart.model ?? threadStart.thread?.model;
      const threadReasoningEffort = hostSelection?.reasoning_effort
        ?? threadStart.reasoningEffort
        ?? threadStart.thread?.reasoningEffort
        ?? null;
      if (typeof threadModel !== 'string' || threadModel.length === 0) {
        throw new Error('Codex did not report the thread model required for collaboration-mode switching.');
      }
      this._interactionBroker = createMilestoneControllerInteractionBroker({
        sessionId: this.sessionId,
        runId: this.threadId,
      });
      this._writeStatus('Working session started.');
      this._writeStatus('Preparing the plan.');

      this.phase = 'preparing';
      const preparationMode = {
        mode: this.nativePlanPresentation ? 'plan' : 'default',
        settings: {
          model: threadModel,
          ...(threadReasoningEffort
            ? { reasoning_effort: threadReasoningEffort }
            : {}),
          developer_instructions: [
            this.resolveBuildApproval === null
              ? `${CRUISE_PREPARATION_INSTRUCTIONS}\n\nThis terminal adapter has no persistent Build-approval resolver. Keep this run in single-slice Goal mode, do not offer a milestone-controller option, and do not write ctrl.yaml.`
              : CRUISE_PREPARATION_INSTRUCTIONS,
            ...(this.cruiseClass === null
              ? []
              : [cruiseClassInstructions(this.cruiseClass, { nativeHost: true })]),
            communicationStyleInstructions(this.communicationStyle),
          ].join('\n\n'),
        },
      };
      const preparationSandbox = {
        type: 'workspaceWrite',
        writableRoots: [this.planningDirectory],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      await this.client.request('thread/settings/update', {
        threadId: this.threadId,
        cwd: this.planningDirectory,
        approvalPolicy: 'on-request',
        sandboxPolicy: preparationSandbox,
        collaborationMode: preparationMode,
      });
      this._throwIfAborted();
      const turnStart = await this.client.request('turn/start', {
        threadId: this.threadId,
        input: [
          { type: 'skill', name: 'goal', path: this.skillPath },
          {
            type: 'text',
            text: preparationPrompt(
              this.prompt,
              this.cwd,
              this.planningDirectory,
              {
                milestoneControllerAvailable: this.resolveBuildApproval !== null,
                nativePlanPresentation: this.nativePlanPresentation,
              },
            ),
            text_elements: [],
          },
        ],
        model: threadModel,
        ...(threadReasoningEffort ? { effort: threadReasoningEffort } : {}),
        collaborationMode: preparationMode,
        cwd: this.planningDirectory,
        runtimeWorkspaceRoots: [],
        sandboxPolicy: preparationSandbox,
        approvalPolicy: 'on-request',
      });
      this.turnId = turnStart.turn.id;
      this._activeTurnIds.add(turnStart.turn.id);

      const preparation = await this._preparationDone.promise;
      await this._interactionTail;
      this._activeTurnIds.clear();
      this._finishAgentMessage();
      this._throwIfAborted();
      if (preparation.status !== 'completed') {
        throw new Error(
          `Cruise preparation ended with turn status ${preparation.status}.`,
        );
      }

      if ((!this.startRequested || !this.goalApproval) && this.implicitGoalAuthorization) {
        try {
          await this._captureImplicitGoalApproval();
        } catch (error) {
          this._writeStatus(`Cruise could not validate the prepared Plan and Goal: ${error.message}`);
        }
      }

      if (!this.startRequested || !this.goalApproval) {
        this.phase = 'saved';
        this._writeStatus('The Plan and Goal were saved. Work has not started.');
        return {
          status: 'saved',
          threadId: this.threadId,
          goal: null,
        };
      }

      this.phase = 'activating';
      this._activationController = new AbortController();
      this._threadStatus = null;
      this._executionTurnObserved = false;
      this._throwIfAborted();
      await this.client.request('thread/settings/update', {
        threadId: this.threadId,
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [this.cwd],
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        collaborationMode: {
          mode: 'default',
          settings: {
            model: threadModel,
            ...(threadReasoningEffort
              ? { reasoning_effort: threadReasoningEffort }
              : {}),
            developer_instructions: [
              ...(this.cruiseClass === null
                ? []
                : [cruiseClassInstructions(this.cruiseClass, { nativeHost: true })]),
              communicationStyleInstructions(this.communicationStyle),
            ].join('\n\n'),
          },
        },
      });
      this._throwIfAborted();

      let activated;
      try {
        activated = await activateApprovedGoal({
          client: this.client,
          threadId: this.threadId,
          cwd: this.cwd,
          approvedSnapshot: this.goalApproval,
          signal: this._activationController.signal,
          rpcTimeoutMs: this.activationRpcTimeoutMs,
        });
      } catch (error) {
        if (error instanceof GoalActivationUncertainError) {
          await this._reconcileUncertainActivation(error);
        }
        if (error.code === 'CRUISE_INTERRUPTED' || error.interrupted) {
          throw new CruiseInterruptedError();
        }
        throw error;
      } finally {
        this._activationController = null;
      }
      this.activeGoal = activated.goal;
      if (this.controllerAuthority !== null) {
        try {
          const hosted = await activateMilestoneControllerHost({
            cwd: this.cwd,
            interactionBroker: this._interactionBroker,
            controllerAuthority: this.controllerAuthority,
            verifiedBuildApproval: this.verifiedBuildApproval,
            approvedSnapshot: this.goalApproval,
            activationResult: activated,
            threadId: this.threadId,
            interactionId: `native-goal-${randomUUID()}`,
          });
          this.controllerDriver = hosted.driver;
          this._writeStatus(`Project handoff is ${hosted.disposition}: ${hosted.driver.describe().milestone_id}.`);
          this.emit('milestoneControllerReady', hosted.driver);
        } catch (cause) {
          await this._failControllerBootstrapSafely(activated, cause);
        }
      }
      if (TERMINAL_GOAL_STATUSES.has(activated.goal.status)) {
        this._terminalGoal = activated.goal;
      }
      if (this._abortRequested) {
        await this._pauseActiveGoal();
        throw new CruiseInterruptedError();
      }

      this.phase = 'executing';
      this._writeStatus('Work has started.');
      this._maybeFinishExecution();

      const goal = await this._executionDone.promise;
      this.activeGoal = goal;
      this.phase = goal.status;
      this._finishAgentMessage();
      this._writeStatus( formatGoalStatus(goal));
      const result = {
        status: goal.status,
        threadId: this.threadId,
        goal,
        artifacts: activated.artifacts,
      };
      if (this.controllerDriver !== null) {
        result.controllerDriver = this.controllerDriver;
        this._controllerDriverTransferred = true;
      }
      return result;
    } finally {
      this._stopping = true;
      if (this.controllerDriver !== null && !this._controllerDriverTransferred) {
        await this.controllerDriver.close('session_ended').catch(() => {});
      } else if (!this._controllerDriverTransferred) {
        this._clearControllerAuthority('session_ended');
        invalidateMilestoneControllerInteractionBroker(
          this._interactionBroker,
          'session_ended',
        );
      }
      clearTimeout(this._continuationTimer);
      await this._interactionTail.catch(() => {});
      await this.client.stop().catch(() => {});
      this._detach();
    }
  }

  async interrupt() {
    if (this._stopping || this._abortRequested) return;
    this._abortRequested = true;
    this.lineReader?.cancel?.('ctrl-c');
    this._activeInteraction?.controller.abort('ctrl-c');
    this._activationController?.abort('ctrl-c');
    if (this.controllerDriver !== null) {
      await this.controllerDriver.close('cancelled').catch(() => {});
    } else {
      this._clearControllerAuthority('cancelled');
    }
    const interrupted = new CruiseInterruptedError();

    if (this.phase === 'preparing') {
      if (this.threadId && this.turnId) {
        await this.client
          .request('turn/interrupt', {
            threadId: this.threadId,
            turnId: this.turnId,
          })
          .catch(() => {});
      }
      this._preparationDone.reject(interrupted);
    } else if (this.phase === 'executing') {
      await this._pauseActiveGoal();
      this._executionDone.reject(interrupted);
    }
  }

  _throwIfAborted() {
    if (this._abortRequested) throw new CruiseInterruptedError();
  }

  _writeStatus(value) {
    const safe = sanitizeUserFacingText(value, {
      style: this.communicationStyle?.style,
    });
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
    this._pendingRequestIds.add(message.id);
    const task = this._interactionTail.then(() => {
      if (this._resolvedRequestIds.has(message.id)) {
        return;
      }
      return this._handleRequest(message);
    });
    const finished = task.finally(() => {
      this._resolvedRequestIds.delete(message.id);
      this._pendingRequestIds.delete(message.id);
    });
    this._interactionTail = finished.catch((error) => {
      this._writeStatus( `Cruise interaction failed: ${error.message}`);
    });
  }

  async _handleRequest(message) {
    if (this._stopping) {
      this._safeRespondError(message.id, new Error('Cruise is stopping.'));
      return;
    }

    const controller = new AbortController();
    this._activeInteraction = { id: message.id, controller };
    try {
      let result;
      switch (message.method) {
        case 'item/tool/requestUserInput':
          result = await this._handleUserInput(
            message.params,
            controller.signal,
            String(message.id),
          );
          break;
        case 'item/commandExecution/requestApproval': {
          if (this._canAutoApproveRoutineToolUse(message.params)) {
            result = {
              decision: message.params.availableDecisions?.includes('acceptForSession')
                ? 'acceptForSession'
                : 'accept',
            };
            this._writeStatus('Routine tool permission auto-approved within the reviewed Goal envelope.');
            break;
          }
          const decision = await answerApprovalRequest(message.params, {
            pickOne: this.pickOne,
            input: this.input,
            output: this.errorOutput,
            lineReader: this.lineReader,
            signal: controller.signal,
            availableDecisions: message.params.availableDecisions,
            communicationStyle: this.communicationStyle?.style,
          });
          result = { decision };
          break;
        }
        case 'item/fileChange/requestApproval': {
          if (this._canAutoApproveRoutineToolUse(message.params)) {
            result = { decision: 'acceptForSession' };
            this._writeStatus('Routine file-change permission auto-approved within the reviewed Goal envelope.');
            break;
          }
          const decision = await answerApprovalRequest(message.params, {
            pickOne: this.pickOne,
            input: this.input,
            output: this.errorOutput,
            lineReader: this.lineReader,
            signal: controller.signal,
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
            communicationStyle: this.communicationStyle?.style,
          });
          result = { decision };
          break;
        }
        case 'execCommandApproval': {
          if (this._canAutoApproveRoutineToolUse(message.params)) {
            result = { decision: 'approved_for_session' };
            this._writeStatus('Routine command permission auto-approved within the reviewed Goal envelope.');
            break;
          }
          const decision = await answerApprovalRequest(
            {
              reason: message.params.reason,
              command: message.params.command ?? [],
            },
            {
              pickOne: this.pickOne,
              input: this.input,
              output: this.errorOutput,
              lineReader: this.lineReader,
              signal: controller.signal,
              availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
              communicationStyle: this.communicationStyle?.style,
            },
          );
          result = {
            decision:
              decision === 'accept'
                ? 'approved'
                : decision === 'acceptForSession'
                  ? 'approved_for_session'
                  : decision === 'cancel'
                    ? 'abort'
                    : 'denied',
          };
          break;
        }
        case 'applyPatchApproval': {
          if (this._canAutoApproveRoutineToolUse(message.params)) {
            result = { decision: 'approved_for_session' };
            this._writeStatus('Routine patch permission auto-approved within the reviewed Goal envelope.');
            break;
          }
          const decision = await answerApprovalRequest(message.params, {
            pickOne: this.pickOne,
            input: this.input,
            output: this.errorOutput,
            lineReader: this.lineReader,
            signal: controller.signal,
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
            communicationStyle: this.communicationStyle?.style,
          });
          result = {
            decision:
              decision === 'accept'
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
          if (this._canAutoApproveRoutineToolUse(message.params)) {
            const requested = message.params.permissions ?? {};
            const permissions = {};
            if (requested.network != null) permissions.network = requested.network;
            if (requested.fileSystem != null) permissions.fileSystem = requested.fileSystem;
            result = { permissions, scope: 'session' };
            this._writeStatus('Routine tool permissions auto-approved within the reviewed Goal envelope.');
            break;
          }
          const decision = await answerApprovalRequest(message.params, {
            pickOne: this.pickOne,
            input: this.input,
            output: this.errorOutput,
            lineReader: this.lineReader,
            signal: controller.signal,
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
            signal: controller.signal,
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
          this._safeRespondError(
            message.id,
            -32601,
            `Cruise does not support server request ${message.method}`,
          );
          return;
      }
      if (!this._resolvedRequestIds.has(message.id)) {
        this._safeRespond(message.id, result);
      }
    } catch (error) {
      this.startRequested = false;
      this.goalApproval = null;
      if (!this._resolvedRequestIds.has(message.id)) {
        this._safeRespondError(message.id, error);
      }
      this._writeStatus( `Cruise interaction failed: ${error.message}`);
    } finally {
      if (this._activeInteraction?.id === message.id) {
        this._activeInteraction = null;
      }
      this._resolvedRequestIds.delete(message.id);
      this._pendingRequestIds.delete(message.id);
    }
  }

  async _captureImplicitGoalApproval() {
    const goalCandidate = await capturePlanGoalApproval(this.cwd, {
      expectedBaseline: this.initialBaseline,
      expectedRawPrompt: this.originPrompt,
      controllerAuthority: this.controllerAuthority,
    });
    if (!(this.nativePlanPresentation && this._nativePlanItemSeen)) {
      this.renderPlan(goalCandidate, this.output);
      this._writeStatus('Showing the validated Cruise Plan and Goal preview.');
    } else {
      this._writeStatus('Using the observed native Plan item for Plan and Goal presentation.');
    }
    await verifyPlanGoalApproval(this.cwd, goalCandidate);
    this.goalApproval = goalCandidate;
    this.startRequested = true;
    this._writeStatus('Plan and Goal snapshot validated; the Cruise Goal invocation authorizes activation.');
    return goalCandidate;
  }

  _implicitQuestionAnswer(question, preferredLabel = null) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const approved = preferredLabel ?? options.find(({ label } = {}) =>
      /^(?:approve(?:\s+(?:both|the\s+(?:plan|goal|contract)))?|start\s+cruise|continue|proceed|execute)\b/iu.test(String(label ?? '')),
    )?.label;
    if (typeof approved !== 'string' || approved.length === 0) return null;
    return { answers: { [question.id]: { answers: [approved] } } };
  }

  async _handleUserInput(params, signal, interactionId = 'request-user-input') {
    const questions = params.questions ?? [];
    const reviewQuestion = questions.find((candidate) =>
      isPlanGoalReviewOptions(candidate?.options),
    ) ?? null;
    const needsQuestion = questions.find((candidate) =>
      isGoalNeedsOptions(candidate?.options),
    ) ?? null;
    const question = questions.length === 1 ? questions[0] : null;
    const options = question?.options ?? [];
    let goalCandidate = null;

    if (this.implicitGoalAuthorization && (reviewQuestion || needsQuestion)) {
      const answers = {};
      if (needsQuestion) {
        this.goalNeedsSelection = 'Select some';
        this.autoApproveRoutineToolUse = false;
        answers[needsQuestion.id] = { answers: ['Select some'] };
        this._writeStatus('Goal autonomy is derived from the Cruise invocation; normal host approvals remain enabled.');
      }
      if (reviewQuestion) {
        try {
          goalCandidate = await this._captureImplicitGoalApproval();
          const reviewAnswer = this._implicitQuestionAnswer(reviewQuestion, 'Approve both');
          if (reviewAnswer === null) {
            throw new Error('The routine Plan and Goal review did not offer an approval response.');
          }
          Object.assign(answers, reviewAnswer.answers);
        } catch (error) {
          this.goalApproval = null;
          this.startRequested = false;
          this._writeStatus(error.message);
          return rejectedAnswer(
            reviewQuestion.id,
            `Plan and Goal validation failed: ${error.message}`,
          );
        }
      }
      return { answers };
    }

    if (this.implicitGoalAuthorization && question) {
      const visible = [
        question.header ?? '',
        question.question ?? '',
        ...options.map(({ label } = {}) => String(label ?? '')),
      ].join(' ');
      const routineAnswer = this._implicitQuestionAnswer(question);
      if (
        routineAnswer !== null &&
        ROUTINE_GOAL_AUTHORIZATION.test(visible) &&
        !HIGH_RISK_AUTO_APPROVAL.test(visible) &&
        !MATERIAL_GOAL_DECISION.test(visible)
      ) {
        this._writeStatus('The Cruise Goal invocation authorizes this routine in-scope transition.');
        return routineAnswer;
      }
    }

    this.startRequested = false;
    this.goalApproval = null;

    if (reviewQuestion) {
      if (this.goalNeedsSelection === null) {
        const message = 'Resolve the Goal-specific needs question before combined approval.';
        this._writeStatus(message);
        return rejectedAnswer(reviewQuestion.id, `Combined review unavailable: ${message}`);
      }
      try {
        goalCandidate = await capturePlanGoalApproval(this.cwd, {
          expectedBaseline: this.initialBaseline,
          expectedRawPrompt: this.originPrompt,
          controllerAuthority: this.controllerAuthority,
        });
        if (!(this.nativePlanPresentation && this._nativePlanItemSeen)) {
          this.renderPlan(goalCandidate, this.output);
          this._writeStatus('Showing Cruise combined Plan and Goal preview.');
        } else {
          this._writeStatus('Using the observed native Plan item for Plan and Goal presentation.');
        }
        this._writeStatus('Combined Plan and Goal review is ready.');
      } catch (error) {
        this._writeStatus(error.message);
        return rejectedAnswer(
          reviewQuestion.id,
          `Combined review unavailable: ${error.message} Fix the complete candidate and ask again.`,
        );
      }
    }

    const answered = await answerUserInputRequest(params, {
      pickOne: this.pickOne,
      readLine: this.readLine,
      input: this.input,
      output: this.errorOutput,
      lineReader: this.lineReader,
      signal,
      communicationStyle: this.communicationStyle?.style,
    });
    if (answered.cancelled) return answered.result;

    if (needsQuestion) {
      const needsSelection = answered.selections.find(({ id }) => id === needsQuestion.id);
      if (needsSelection?.source === 'option') {
        this.goalNeedsSelection = needsSelection.answer;
        this.autoApproveRoutineToolUse = needsSelection.answer === 'Approve all';
        this._writeStatus(`Goal-specific needs recorded: ${needsSelection.answer}.`);
      }
      return answered.result;
    }

    const combinedSelection = reviewQuestion
      ? answered.selections.find(({ id }) => id === reviewQuestion.id)
      : null;
    if (combinedSelection?.approvePlanGoal) {
      try {
        await verifyPlanGoalApproval(this.cwd, goalCandidate);
        this.goalApproval = goalCandidate;
        this.startRequested = true;
        this._writeStatus('Plan and Goal approval saved.');
      } catch (error) {
        this.goalApproval = null;
        this.startRequested = false;
        replaceAnswer(
          answered.result,
          combinedSelection.id,
          `Approve both rejected by Cruise client: ${error.message}`,
        );
        this._writeStatus(error.message);
      }
      return answered.result;
    }
    if (combinedSelection) {
      this.goalApproval = null;
      this.startRequested = false;
      if (combinedSelection.answer === 'Refine') this._nativePlanItemSeen = false;
      this._writeStatus(
        combinedSelection.answer === 'Refine'
          ? 'Plan and Goal returned for refinement.'
          : 'Plan and Goal rejected; work remains inactive.',
      );
      return answered.result;
    }

    const selection = answered.selections.at(-1);
    if (!selection) return answered.result;

    if (
      this._interactionBroker &&
      ['text', 'other'].includes(selection.source) &&
      selection.answer.length > 0
    ) {
      this.lastDirectUserEventReceipt =
        this._interactionBroker.observeDirectUserResponse({
          interactionId,
          answer: selection.answer,
          source: selection.source,
        });
      this.emit('directUserEvent', this.lastDirectUserEventReceipt);
    }

    const controllerMilestoneId = milestoneControllerSelectionId(selection.answer);
    const controllerOptionOffered = options.some(
      (option) => milestoneControllerSelectionId(option.label) !== null,
    );
    if (controllerMilestoneId !== null && selection.source !== 'option') {
      this._clearControllerAuthority('controller_selection_unstructured');
      replaceAnswer(
        answered.result,
        selection.id,
        'Milestone Controller rejected by Cruise client: select the exact structured Use Milestone Controller M-XX option; typed or Other text is not approval.',
      );
      return answered.result;
    }
    if (controllerMilestoneId !== null && selection.source === 'option') {
      this._clearControllerAuthority('new_controller_selection');
      try {
        if (!this._interactionBroker) {
          throw new Error('The current session interaction broker is unavailable.');
        }
        if (!this.resolveBuildApproval) {
          throw new Error('No persisted Build approval resolver is configured.');
        }
        const selectionReceipt = this._interactionBroker.observeStructuredSelection({
          interactionId,
          answer: selection.answer,
          source: selection.source,
        });
        const resolvedBuildApproval = await this.resolveBuildApproval({
          cwd: this.cwd,
          milestoneId: controllerMilestoneId,
          sessionId: this.sessionId,
          runId: this.threadId,
        });
        const persistedBuildApproval =
          resolvedBuildApproval?.approval ?? resolvedBuildApproval;
        const verifiedBuildApproval = await verifyBuildApproval({
          root: this.cwd,
          approval: persistedBuildApproval,
          approvalSelection: resolvedBuildApproval?.approvalSelection,
          currentRepositoryBaselineDigest: captureRepositoryBaseline(this.cwd).sha256,
          buildOriginPairAuthority: resolvedBuildApproval?.buildOriginPairAuthority,
          buildIdHistoryAuthority: resolvedBuildApproval?.buildIdHistoryAuthority,
        });
        this.controllerAuthority = await establishMilestoneControllerAuthority({
          interactionBroker: this._interactionBroker,
          selectionReceipt,
          verifiedBuildApproval,
        });
        this.verifiedBuildApproval = verifiedBuildApproval;
        this._writeStatus(`Project handoff selected: ${controllerMilestoneId}.`);
      } catch (error) {
        this._clearControllerAuthority('selection_rejected');
        replaceAnswer(
          answered.result,
          selection.id,
          `Milestone Controller rejected by Cruise client: ${error.message}`,
        );
        this._writeStatus( error.message);
      }
      return answered.result;
    }
    if (controllerOptionOffered) {
      this._clearControllerAuthority('controller_selection_changed');
    }
    return answered.result;
  }

  _clearControllerAuthority(reason) {
    if (this.controllerAuthority) {
      invalidateMilestoneControllerAuthority(this.controllerAuthority, reason);
      this.controllerAuthority = null;
    }
    this.verifiedBuildApproval = null;
  }

  _canAutoApproveRoutineToolUse(params) {
    if (
      !this.autoApproveRoutineToolUse ||
      !['activating', 'executing'].includes(this.phase)
    ) {
      return false;
    }
    const visible = JSON.stringify({
      reason: params?.reason ?? null,
      command: params?.command ?? null,
      permissions: params?.permissions ?? null,
    });
    return !HIGH_RISK_AUTO_APPROVAL.test(visible);
  }

  _safeRespond(id, result) {
    try {
      this.client.respond(id, result);
    } catch (error) {
      if (!this._stopping) throw error;
    }
  }

  _safeRespondError(id, codeOrError, message) {
    try {
      this.client.respondError(id, codeOrError, message);
    } catch (error) {
      if (!this._stopping) throw error;
    }
  }

  _handleNotification(message) {
    const params = message.params ?? {};
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;

    if (message.method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      if (!this._pendingRequestIds.has(requestId)) return;
      this._resolvedRequestIds.add(requestId);
      if (this._activeInteraction?.id === requestId) {
        this._activeInteraction.controller.abort('resolved');
      }
      return;
    }

    switch (message.method) {
      case 'turn/started': {
        const id = params.turn?.id;
        if (id) {
          this.turnId = id;
          this._activeTurnIds.add(id);
        }
        this._turnGeneration += 1;
        if (['activating', 'executing'].includes(this.phase)) {
          this._executionTurnObserved = true;
          clearTimeout(this._continuationTimer);
        }
        break;
      }
      case 'turn/completed': {
        this._agentMessages.flush();
        const id = params.turn?.id;
        if (id) this._activeTurnIds.delete(id);
        if (this.turnId === id) this.turnId = null;
        if (this.phase === 'preparing') {
          this._preparationDone.resolve(params.turn);
        } else if (['activating', 'executing'].includes(this.phase)) {
          void this._refreshGoal();
          this._maybeFinishExecution();
          this._scheduleContinuationGuard(params.turn);
        }
        break;
      }
      case 'item/agentMessage/delta':
        this._agentMessages.append(params.delta);
        break;
      case 'item/completed':
        if (params.item?.type === 'plan') {
          this._agentMessages.flush();
          const text = String(params.item.text ?? '');
          this._nativePlanItemSeen =
            /^#{1,3}\s+Plan\b/im.test(text) &&
            /^#{1,3}\s+Goal\b/im.test(text);
        }
        break;
      case 'thread/goal/updated':
        this.activeGoal = params.goal;
        this._terminalGoal = TERMINAL_GOAL_STATUSES.has(params.goal?.status)
          ? params.goal
          : null;
        this._maybeFinishExecution();
        break;
      case 'thread/status/changed':
        this._threadStatus = params.status?.type ?? null;
        this._maybeFinishExecution();
        break;
      case 'error':
      case 'warning':
      case 'configWarning':
        this._writeStatus(params.message ?? params.error?.message ?? JSON.stringify(params));
        break;
      default:
        break;
    }
  }

  _maybeFinishExecution() {
    if (
      this._terminalGoal &&
      this._activeTurnIds.size === 0 &&
      (this._executionTurnObserved || this._threadStatus === 'idle')
    ) {
      this._executionDone.resolve(this._terminalGoal);
    }
  }

  async _refreshGoal() {
    if (!this.threadId || this._executionDone.settled || this._stopping) return;
    try {
      const { goal } = await this.client.request('thread/goal/get', {
        threadId: this.threadId,
      });
      this.activeGoal = goal;
      this._terminalGoal = TERMINAL_GOAL_STATUSES.has(goal?.status) ? goal : null;
      this._maybeFinishExecution();
    } catch (error) {
      this._executionDone.reject(error);
    }
  }

  _scheduleContinuationGuard(turn) {
    clearTimeout(this._continuationTimer);
    const generation = this._turnGeneration;
    this._continuationTimer = setTimeout(() => {
      void this._guardContinuation(turn, generation);
    }, this.continuationGraceMs);
  }

  async _guardContinuation(turn, generation) {
    if (
      this._stopping ||
      this._executionDone.settled ||
      this._activeTurnIds.size > 0 ||
      this._turnGeneration !== generation ||
      !['activating', 'executing'].includes(this.phase)
    ) {
      return;
    }
    try {
      const { goal } = await this.client.request('thread/goal/get', {
        threadId: this.threadId,
      });
      if (
        this._stopping ||
        this._executionDone.settled ||
        this._activeTurnIds.size > 0 ||
        this._turnGeneration !== generation
      ) {
        return;
      }
      if (TERMINAL_GOAL_STATUSES.has(goal?.status)) {
        this._terminalGoal = goal;
        this._maybeFinishExecution();
        return;
      }
      if (goal?.status === 'active') {
        this._writeStatus(`The work stopped unexpectedly (${turn?.status ?? 'ended'}), so it was paused.`);
        const paused = await this.client.request('thread/goal/set', {
          threadId: this.threadId,
          status: 'paused',
        });
        this.activeGoal = paused.goal;
        this._terminalGoal = paused.goal;
        this._maybeFinishExecution();
      }
    } catch (error) {
      this._executionDone.reject(error);
    }
  }

  async _pauseActiveGoal() {
    if (!this.threadId) return;
    if (this.turnId) {
      await this.client
        .request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId,
        })
        .catch(() => {});
    }
    const current = await this.client
      .request('thread/goal/get', { threadId: this.threadId })
      .catch(() => ({ goal: null }));
    if (current.goal) {
      await this.client
        .request('thread/goal/set', {
          threadId: this.threadId,
          status: 'paused',
        })
        .catch(() => {});
    }
  }

  async _failControllerBootstrapSafely(activated, cause) {
    this.activeGoal = activated.goal;
    const before = await this.client
      .request('thread/goal/get', { threadId: this.threadId })
      .catch(() => ({ goal: null }));
    if (
      before.goal?.objective !== activated.objective ||
      (activated.goal?.threadId != null &&
        before.goal?.threadId !== activated.goal.threadId)
    ) {
      await this.client.stop().catch(() => {});
      throw new Error(
        'Milestone controller runtime bootstrap failed, but the current Goal no longer matches the activated controller Goal; Cruise left it unchanged and stopped the app-server.',
        { cause },
      );
    }
    if (before.goal.status !== 'paused') {
      if (this.turnId) {
        await this.client
          .request('turn/interrupt', {
            threadId: this.threadId,
            turnId: this.turnId,
          })
          .catch(() => {});
      }
      await this.client
        .request('thread/goal/set', {
          threadId: this.threadId,
          status: 'paused',
        })
        .catch(() => ({ goal: null }));
    }
    const after = await this.client
      .request('thread/goal/get', { threadId: this.threadId })
      .catch(() => ({ goal: null }));
    if (
      after.goal?.objective === activated.objective &&
      after.goal.status === 'paused' &&
      (activated.goal?.threadId == null ||
        after.goal.threadId === activated.goal.threadId)
    ) {
      this.activeGoal = after.goal;
      throw new Error(
        `Milestone controller runtime bootstrap failed; the matching native Goal was paused safely: ${cause.message}`,
        { cause },
      );
    }
    await this.client.stop().catch(() => {});
    throw new Error(
      'Milestone controller runtime bootstrap failed and Cruise could not confirm a safe pause of the exact activated Goal; the app-server was stopped.',
      { cause },
    );
  }

  async _reconcileUncertainActivation(error) {
    const expectedObjective = error?.objective;
    if (!this.threadId || !expectedObjective) return;
    const timeoutMs = Math.max(
      250,
      Math.min(error.rpcTimeoutMs ?? this.activationRpcTimeoutMs, 30_000),
    );
    const deadline = Date.now() + timeoutMs;
    let pendingSettled = !error.pendingRequest;
    error.pendingRequest?.then(
      () => {
        pendingSettled = true;
      },
      () => {
        pendingSettled = true;
      },
    );

    while (Date.now() < deadline) {
      // If the set RPC settles while a read is in flight, that read may still
      // have observed the pre-commit state. Require one read that begins after
      // settlement before concluding that no matching Goal exists.
      const readStartedAfterSettlement = pendingSettled;
      const remaining = deadline - Date.now();
      const current = await this._boundedRequest(
        'thread/goal/get',
        { threadId: this.threadId },
        Math.min(1_000, remaining),
      ).catch(() => ({ goal: null }));
      if (current.goal?.objective === expectedObjective) {
        await this._makeReconciledGoalSafe(current.goal, expectedObjective, error);
        return;
      }
      if (pendingSettled && readStartedAfterSettlement) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Settlement at the edge of the polling deadline still gets one ordered
    // post-set read. This closes the gap where the final in-flight read saw
    // null immediately before the set response arrived.
    if (pendingSettled) {
      const current = await this._boundedRequest(
        'thread/goal/get',
        { threadId: this.threadId },
        250,
      ).catch(() => ({ goal: null }));
      if (current.goal?.objective === expectedObjective) {
        await this._makeReconciledGoalSafe(current.goal, expectedObjective, error);
      }
      return;
    }

    // A local set RPC that has not settled by its deadline must not outlive
    // reconciliation and commit after the caller has returned.
    if (!pendingSettled) {
      await this.client.stop().catch(() => {});
    }
  }

  async _makeReconciledGoalSafe(initialGoal, expectedObjective, activationError) {
    let goal = initialGoal;
    this.activeGoal = goal;
    if (TERMINAL_GOAL_STATUSES.has(goal.status)) return;

    const deadline = Date.now() + 1_000;
    if (this.turnId) {
      await this._boundedRequest(
        'turn/interrupt',
        { threadId: this.threadId, turnId: this.turnId },
        Math.min(250, Math.max(1, deadline - Date.now())),
      ).catch(() => {});
    }

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const paused = await this._boundedRequest(
        'thread/goal/set',
        { threadId: this.threadId, status: 'paused' },
        Math.min(250, remaining),
      ).catch(() => ({ goal: null }));
      if (paused.goal?.objective === expectedObjective) {
        goal = paused.goal;
        this.activeGoal = goal;
        if (TERMINAL_GOAL_STATUSES.has(goal.status)) break;
      }

      const current = await this._boundedRequest(
        'thread/goal/get',
        { threadId: this.threadId },
        Math.min(250, Math.max(1, deadline - Date.now())),
      ).catch(() => ({ goal: null }));
      if (current.goal?.objective === expectedObjective) {
        goal = current.goal;
        this.activeGoal = goal;
        if (TERMINAL_GOAL_STATUSES.has(goal.status)) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      await this.client.stop().catch(() => {});
      throw new Error(
        'Cruise could not confirm that the matching native Goal was paused; the app-server was stopped.',
        { cause: activationError },
      );
    }

    if (goal.status === 'paused') {
      this._writeStatus('Could not confirm that work began, so it was paused.');
    } else {
      this._writeStatus(`Could not confirm that work began; it ended with status ${goal.status}.`);
    }
  }

  _boundedRequest(method, params, timeoutMs) {
    const request = this.client.request(method, params);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`Timed out waiting for ${method}.`)),
        Math.max(1, timeoutMs),
      );
      request.then(
        (value) => finish(resolve, value),
        (requestError) => finish(reject, requestError),
      );
    });
  }

  _handleExit(info) {
    if (this._stopping) return;
    this._agentMessages.flush();
    const error =
      info?.error ??
      new Error(
        `Codex app-server exited before Cruise finished${
          info?.code == null ? '' : ` (code ${info.code})`
        }.`,
      );
    if (this.phase === 'preparing') {
      this._preparationDone.reject(error);
    } else if (['activating', 'executing'].includes(this.phase)) {
      this._executionDone.reject(error);
    }
  }

  _finishAgentMessage() {
    this._agentMessages.flush();
  }
}
