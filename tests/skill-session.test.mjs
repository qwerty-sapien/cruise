import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  CruiseSkillSession,
  cruiseWorkflowPhases,
} from '../scripts/lib/skill-session.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';

class MemoryOutput {
  constructor() {
    this.value = '';
  }

  write(chunk) {
    this.value += String(chunk);
    return true;
  }
}

class FakeClient extends EventEmitter {
  constructor({ askInClarify = false } = {}) {
    super();
    this.askInClarify = askInClarify;
    this.calls = [];
    this.responses = [];
    this.turnSequence = 0;
    this.stopped = false;
  }

  async start() {
    this.calls.push({ method: 'initialize' });
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') {
      return {
        thread: { id: 'thread-staged' },
        model: 'gpt-test',
        reasoningEffort: 'medium',
      };
    }
    if (method === 'model/list') {
      return {
        data: [{
          id: MODEL_IDS.terra,
          model: MODEL_IDS.terra,
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
        }],
      };
    }
    if (method === 'thread/settings/update') return {};
    if (method === 'turn/start') {
      this.turnSequence += 1;
      const id = `turn-${this.turnSequence}`;
      const phase = params.responsesapiClientMetadata.cruise_phase;
      setImmediate(() => {
        if (this.askInClarify && phase === 'clarify') {
          this.emit('request', {
            id: 'question-clarify',
            method: 'item/tool/requestUserInput',
            params: {
              questions: [{
                id: 'scope',
                header: 'Scope',
                question: 'Which boundary?',
                options: [
                  { label: 'Bounded', description: 'Keep the change finite.' },
                  { label: 'Broad', description: 'Expand the change.' },
                ],
              }],
            },
          });
        }
        this.emit('notification', {
          method: 'turn/completed',
          params: { turn: { id, status: 'completed' } },
        });
      });
      return { turn: { id, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected request ${method}`);
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, error) {
    throw new Error(`Unexpected response error for ${id}: ${error?.message ?? error}`);
  }

  async stop() {
    this.stopped = true;
  }
}

function createSession(client, skill, { cruiseClass = null } = {}) {
  return new CruiseSkillSession({
    client,
    cwd: '/repo',
    prompt: 'Do the requested work.',
    skill,
    skillPath: `/plugin/skills/${skill}/SKILL.md`,
    pickOne: async () => ({
      status: 'selected',
      index: 0,
      value: 'Bounded',
      via: 'tty',
    }),
    readLine: async () => '',
    input: {},
    output: new MemoryOutput(),
    errorOutput: new MemoryOutput(),
    cruiseClass,
  });
}

test('Build uses one thread and switches Default/Plan without user retry choreography', async () => {
  const client = new FakeClient({ askInClarify: true });
  const result = await createSession(client, 'build').run();

  assert.equal(result.status, 'complete');
  assert.equal(client.stopped, true);
  assert.deepEqual(
    cruiseWorkflowPhases('build'),
    [
      { name: 'capture', mode: 'default' },
      { name: 'clarify', mode: 'plan' },
      { name: 'draft', mode: 'default' },
      { name: 'approval', mode: 'plan' },
      { name: 'finalize', mode: 'default' },
    ],
  );

  const settings = client.calls.filter(({ method }) => method === 'thread/settings/update');
  const turns = client.calls.filter(({ method }) => method === 'turn/start');
  assert.equal(settings.length, 5);
  assert.equal(turns.length, 5);
  assert.deepEqual(
    settings.map(({ params }) => params.collaborationMode.mode),
    ['default', 'plan', 'default', 'plan', 'default'],
  );
  assert.deepEqual(
    turns.map(({ params }) => params.collaborationMode.mode),
    ['default', 'plan', 'default', 'plan', 'default'],
  );
  for (let index = 0; index < turns.length; index += 1) {
    assert.equal(
      client.calls.indexOf(settings[index]) < client.calls.indexOf(turns[index]),
      true,
      `settings must precede turn ${index + 1}`,
    );
    assert.equal(turns[index].params.threadId, 'thread-staged');
    assert.equal(turns[index].params.collaborationMode.settings.model, 'gpt-test');
    assert.equal(turns[index].params.collaborationMode.settings.reasoning_effort, 'medium');
    if (turns[index].params.collaborationMode.mode === 'plan') {
      assert.equal(turns[index].params.sandboxPolicy.type, 'readOnly');
      assert.equal(turns[index].params.approvalPolicy, 'on-request');
    } else {
      assert.equal(turns[index].params.sandboxPolicy.type, 'workspaceWrite');
    }
  }
  assert.equal(client.responses.length, 1);
  assert.deepEqual(client.responses[0].result.answers.scope.answers, ['Bounded']);
  const prompt = turns[0].params.input.find(({ type }) => type === 'text').text;
  assert.match(prompt, /^<system>/u);
  assert.match(prompt, /<user><!\[CDATA\[/u);
});

test('Refine keeps clarification and review read-only and execution write-capable', async () => {
  const client = new FakeClient();
  await createSession(client, 'refine').run();
  const turns = client.calls.filter(({ method }) => method === 'turn/start');

  assert.deepEqual(
    turns.map(({ params }) => [
      params.responsesapiClientMetadata.cruise_phase,
      params.collaborationMode.mode,
      params.sandboxPolicy.type,
    ]),
    [
      ['capture', 'default', 'workspaceWrite'],
      ['clarify', 'plan', 'readOnly'],
      ['draft', 'default', 'workspaceWrite'],
      ['approval', 'plan', 'readOnly'],
      ['execute', 'default', 'workspaceWrite'],
    ],
  );
  const executePrompt = turns.at(-1).params.input.find(({ type }) => type === 'text').text;
  assert.match(executePrompt, /run the canonical\s+foreign-diff check once/u);
  assert.match(executePrompt, /erases their incident history after auto-clearing/u);
  assert.match(executePrompt, /never an\s+incident: do not mention them/u);
});

test('native Cruise pins both host thread and staged turns to the selected class', async () => {
  const client = new FakeClient();
  await createSession(client, 'debug', {
    cruiseClass: { cruise_class: 'normal-cruise' },
  }).run();

  const thread = client.calls.find(({ method }) => method === 'thread/start').params;
  assert.equal(thread.model, MODEL_IDS.terra);
  assert.equal(thread.allowProviderModelFallback, false);
  assert.match(thread.developerInstructions, /native Cruise host is also pinned to level 4/u);
  const turns = client.calls.filter(({ method }) => method === 'turn/start');
  assert.equal(turns.every(({ params }) => params.model === MODEL_IDS.terra), true);
  assert.equal(turns.every(({ params }) => params.effort === 'xhigh'), true);
  assert.equal(
    turns.every(({ params }) => /ordinary-work default is level 4/u.test(
      params.collaborationMode.settings.developer_instructions,
    )),
    true,
  );
});
