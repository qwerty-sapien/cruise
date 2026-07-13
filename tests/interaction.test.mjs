import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  answerApprovalRequest,
  answerUserInputRequest,
} from '../scripts/lib/interaction.mjs';
import { createLineReader } from '../scripts/lib/line-input.mjs';
import { pickOne } from '../scripts/lib/picker.mjs';

const request = (label, overrides = {}) => ({
  autoResolutionMs: null,
  questions: [
    {
      id: 'review',
      header: 'Review',
      question: 'What next?',
      isOther: true,
      isSecret: false,
      options: [
        { label, description: 'Continue with this choice.' },
        { label: 'Revise', description: 'Return to the contract.' },
      ],
    },
  ],
  ...overrides,
});

function dependencies(index = 0) {
  return {
    pickOne: async () => ({ status: 'selected', index, value: '', via: 'tty' }),
    readLine: async () => 'free text',
    input: {},
    output: { write() {} },
  };
}

test('returns the selected label in the app-server response shape', async () => {
  const answered = await answerUserInputRequest(
    request('Recommended path'),
    dependencies(),
  );
  assert.deepEqual(answered.result, {
    answers: { review: { answers: ['Recommended path'] } },
  });
  assert.equal(answered.startRequested, false);
});

test('only exact Start Cruise requests activation', async () => {
  const plan = await answerUserInputRequest(request('Approve Plan'), dependencies());
  const goal = await answerUserInputRequest(request('Start Cruise'), dependencies());
  const nearMiss = await answerUserInputRequest(
    request('Start Cruise later'),
    dependencies(),
  );
  assert.equal(plan.selections[0].approvePlan, true);
  assert.equal(plan.startRequested, false);
  assert.equal(goal.startRequested, true);
  assert.equal(nearMiss.startRequested, false);
});

test('option response normalization cannot turn whitespace near misses into approval tokens', async () => {
  const paddedPlan = await answerUserInputRequest(
    request(' Approve Plan '),
    dependencies(),
  );
  const paddedStart = await answerUserInputRequest(
    request('\tStart Cruise\n'),
    dependencies(),
  );

  assert.deepEqual(paddedPlan.result.answers.review.answers, ['Approve Plan']);
  assert.equal(paddedPlan.selections[0].approvePlan, false);
  assert.deepEqual(paddedStart.result.answers.review.answers, ['Start Cruise']);
  assert.equal(paddedStart.startRequested, false);
});

test('supports the free-text Other route', async () => {
  const answered = await answerUserInputRequest(
    request('Recommended path'),
    dependencies(2),
  );
  assert.deepEqual(answered.result.answers.review.answers, ['free text']);
});

test('typing Start Cruise through Other is not an approval-token selection', async () => {
  const answered = await answerUserInputRequest(request('Recommended path'), {
    ...dependencies(2),
    readLine: async () => 'Start Cruise',
  });
  assert.equal(answered.selections[0].source, 'other');
  assert.equal(answered.startRequested, false);
});

test('shared non-TTY input survives picker, Other text, and a later picker', async () => {
  const input = Readable.from(['3\ncustom direction\n2\n']);
  const output = { isTTY: false, write() { return true; } };
  const lineReader = createLineReader({ input });
  const common = {
    pickOne,
    readLine: async ({ prompt }) => lineReader.question({ prompt, output }),
    lineReader,
    input,
    output,
  };

  const first = await answerUserInputRequest(request('Recommended'), common);
  const second = await answerUserInputRequest(request('Recommended'), common);
  assert.deepEqual(first.result.answers.review.answers, ['custom direction']);
  assert.deepEqual(second.result.answers.review.answers, ['Revise']);
  lineReader.close();
});

test('cancellation can never authorize Start', async () => {
  let calls = 0;
  const answered = await answerUserInputRequest(request('Start Cruise'), {
    ...dependencies(),
    pickOne: async () => {
      calls += 1;
      return { status: 'cancelled', reason: 'q', via: 'tty' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(answered.cancelled, true);
  assert.equal(answered.startRequested, false);
});

test('rejects monolithic and auto-resolving question requests', async () => {
  const twoQuestions = request('One');
  twoQuestions.questions.push({ ...twoQuestions.questions[0], id: 'second' });
  await assert.rejects(
    answerUserInputRequest(twoQuestions, dependencies()),
    /exactly one adaptive question/,
  );
  await assert.rejects(
    answerUserInputRequest(
      request('One', { autoResolutionMs: 60_000 }),
      dependencies(),
    ),
    /without autoResolutionMs/,
  );
});

test('command approvals display the complete command separately', async () => {
  const chunks = [];
  const command = `deploy ${'x'.repeat(120)} --dangerous-final-flag`;
  const decision = await answerApprovalRequest(
    { command, reason: null },
    {
      pickOne: async ({ title }) => {
        assert.equal(title, 'Command approval');
        return { status: 'selected', index: 1 };
      },
      input: {},
      output: { write(value) { chunks.push(String(value)); } },
      availableDecisions: ['accept', 'decline'],
    },
  );
  assert.equal(decision, 'decline');
  assert.match(chunks.join(''), /--dangerous-final-flag/);
});

test('legacy argv approvals preserve argument boundaries and escapes', async () => {
  const chunks = [];
  await answerApprovalRequest(
    { command: ['tool', 'two words', 'line\nbreak'], reason: null },
    {
      pickOne: async () => ({ status: 'selected', index: 1 }),
      input: {},
      output: { write(value) { chunks.push(String(value)); } },
      availableDecisions: ['accept', 'decline'],
    },
  );
  const rendered = chunks.join('');
  assert.match(rendered, /argv\[0\]="tool"/);
  assert.match(rendered, /argv\[1\]="two words"/);
  assert.match(rendered, /argv\[2\]="line\\nbreak"/);
});
