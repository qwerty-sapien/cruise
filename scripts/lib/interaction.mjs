import {
  isApprovePlanChoice,
  isStartCruiseChoice,
} from './goal-contract.mjs';

function writeLine(output, value = '') {
  output.write(`${value}\n`);
}

function questionTitle(question) {
  const header = String(question.header ?? '').trim();
  const prompt = String(question.question ?? '').trim();
  return header ? `${header}: ${prompt}` : prompt;
}

function displayOption(option) {
  const label = String(option.label ?? '').trim();
  const description = String(option.description ?? '').trim();
  return description ? `${label} — ${description}` : label;
}

function visibleText(value) {
  return String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ');
}

function displayCommand(command) {
  if (Array.isArray(command)) {
    return command
      .map((argument, index) => `argv[${index}]=${JSON.stringify(String(argument))}`)
      .join('\n');
  }
  return String(command ?? '').trim();
}

export async function answerUserInputRequest(
  params,
  { pickOne, readLine, input, output, lineReader = null, signal = null },
) {
  const questions = params.questions ?? [];
  if (questions.length !== 1) {
    throw new Error(
      `Cruise requires exactly one adaptive question per request; received ${questions.length}.`,
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
          prompt: `${questionTitle(question)} `,
          input,
          output,
          secret: Boolean(question.isSecret),
          lineReader,
          signal,
        });
      } else {
        const pickerOptions = options.map(displayOption);
        if (question.isOther) pickerOptions.push('Other — type a different answer');
        const picked = await pickOne({
          title: questionTitle(question),
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
  },
) {
  const decisions = (availableDecisions ?? ['accept', 'decline', 'cancel']).filter(
    (decision) => typeof decision === 'string' && APPROVAL_LABELS[decision],
  );
  if (decisions.length === 0) decisions.push('decline');

  const reason = String(params.reason ?? '').trim();
  const command = displayCommand(params.command);
  const title = reason || (command ? 'Command approval' : 'Permission approval');
  if (command) {
    writeLine(output, 'Command:');
    writeLine(output, visibleText(command));
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
  if (!goal) return 'No persisted Goal';
  const tokenText =
    typeof goal.tokensUsed === 'number'
      ? `, ${goal.tokensUsed.toLocaleString()} tokens used`
      : '';
  return `Goal ${goal.status}${tokenText}`;
}
