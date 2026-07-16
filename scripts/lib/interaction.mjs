import {
  isApprovePlanChoice,
  isApprovePlanGoalChoice,
  isStartCruiseChoice,
} from './goal-contract.mjs';
import { sanitizeUserFacingText } from './user-facing-output.mjs';

function writeLine(output, value = '') {
  output.write(`${value}\n`);
}

function questionTitle(question, style) {
  const header = sanitizeUserFacingText(question.header, { style });
  const prompt = sanitizeUserFacingText(question.question, { style });
  return header ? `${header}: ${prompt}` : prompt;
}

function displayOption(option, style) {
  const label = sanitizeUserFacingText(option.label, { style });
  const description = sanitizeUserFacingText(option.description, { style });
  return description ? `${label} — ${description}` : label;
}

function visibleText(value, style) {
  return sanitizeUserFacingText(value, { style });
}

function displayCommand(command, style) {
  if (Array.isArray(command)) {
    return command
      .map((argument, index) => `argv[${index}]=${JSON.stringify(String(argument))}`)
      .join('\n');
  }
  return sanitizeUserFacingText(command, { style });
}

export async function answerUserInputRequest(
  params,
  { pickOne, readLine, input, output, lineReader = null, signal = null, communicationStyle = 'default' },
) {
  const questions = params.questions ?? [];
  if (questions.length < 1 || questions.length > 2) {
    throw new Error(
      `Cruise requires one adaptive question, or the two-question Goal review; received ${questions.length}.`,
    );
  }
  if (params.autoResolutionMs != null) {
    throw new Error(
      'Cruise decisions must remain blocking; retry without autoResolutionMs.',
    );
  }

  const answers = {};
  const selections = [];
  let cancelled = false;

  for (const question of questions) {
    const options = Array.isArray(question.options) ? question.options : [];
    let answer;
    let answerSource = 'text';
    let selectedOptionLabel = null;

    try {
      if (options.length === 0) {
        answer = await readLine({
          prompt: `${questionTitle(question, communicationStyle)} `,
          input,
          output,
          secret: Boolean(question.isSecret),
          lineReader,
          signal,
        });
      } else {
        const pickerOptions = options.map((option) => displayOption(option, communicationStyle));
        if (question.isOther) pickerOptions.push('Other — type a different answer');
        const picked = await pickOne({
          title: questionTitle(question, communicationStyle),
          options: pickerOptions,
          input,
          output,
          lineReader,
          signal,
        });

        if (picked.status !== 'selected') {
          cancelled = true;
          answer = '';
        } else if (picked.index >= options.length) {
          answerSource = 'other';
          answer = await readLine({
            prompt: 'Other: ',
            input,
            output,
            secret: Boolean(question.isSecret),
            lineReader,
            signal,
          });
        } else {
          answerSource = 'option';
          selectedOptionLabel = String(options[picked.index].label ?? '');
          answer = selectedOptionLabel.trim();
        }
      }
    } catch (error) {
      if (error?.code !== 'CRUISE_INPUT_CANCELLED') throw error;
      cancelled = true;
      answer = '';
    }

    const normalizedAnswer = String(answer ?? '').trim();
    answers[question.id] = {
      answers: normalizedAnswer ? [normalizedAnswer] : [],
    };
    selections.push({
      id: question.id,
      answer: normalizedAnswer,
      source: answerSource,
      approvePlan:
        answerSource === 'option' && isApprovePlanChoice(selectedOptionLabel),
      approvePlanGoal:
        answerSource === 'option' && isApprovePlanGoalChoice(selectedOptionLabel),
      startCruise:
        answerSource === 'option' && isStartCruiseChoice(selectedOptionLabel),
    });
    if (cancelled) break;
  }

  return {
    result: { answers },
    selections,
    cancelled,
    startRequested:
      !cancelled && selections.length > 0 && selections.at(-1).startCruise,
  };
}

const APPROVAL_LABELS = Object.freeze({
  accept: 'Allow once',
  acceptForSession: 'Allow for this session',
  decline: 'Deny',
  cancel: 'Cancel request',
});

export async function answerApprovalRequest(
  params,
  {
    pickOne,
    input,
    output,
    availableDecisions,
    lineReader = null,
    signal = null,
    communicationStyle = 'default',
  },
) {
  const decisions = (availableDecisions ?? ['accept', 'decline', 'cancel']).filter(
    (decision) => typeof decision === 'string' && APPROVAL_LABELS[decision],
  );
  if (decisions.length === 0) decisions.push('decline');

  const reason = sanitizeUserFacingText(params.reason, { style: communicationStyle });
  const command = displayCommand(params.command, communicationStyle);
  const title = reason || (command ? 'Command approval' : 'Permission approval');
  if (command) {
    writeLine(output, 'Command:');
    writeLine(output, visibleText(command, communicationStyle));
  }

  const picked = await pickOne({
    title,
    options: decisions.map((decision) => APPROVAL_LABELS[decision]),
    input,
    output,
    lineReader,
    signal,
  });
  if (picked.status !== 'selected') return 'cancel';
  return decisions[picked.index];
}

export function formatGoalStatus(goal) {
  if (!goal) return 'No work status is available';
  const tokenText =
    typeof goal.tokensUsed === 'number'
      ? `, ${goal.tokensUsed.toLocaleString()} tokens used`
      : '';
  return `Work ${goal.status}${tokenText}`;
}
