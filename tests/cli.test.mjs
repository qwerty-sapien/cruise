import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CLI_VERSION,
  evaluateWorkerModelCatalog,
  parseArgs,
  PUBLIC_SKILLS,
  readLineOnce,
} from '../scripts/cruise.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { createLineReader } from '../scripts/lib/line-input.mjs';

test('parses direct prompt and start options', () => {
  const parsed = parseArgs(['start', '-C', '.', 'ship', 'it']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.cwd, resolve('.'));
  assert.equal(parsed.prompt, 'ship it');
});

test('rejects root-model overrides because Cruise delegates model-specific work', () => {
  assert.throws(() => parseArgs(['--model', 'gpt-test', 'ship it']), /Unknown option/);
});

function modelCatalog() {
  return {
    data: [
      {
        id: MODEL_IDS.luna,
        model: MODEL_IDS.luna,
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: MODEL_IDS.terra,
        model: MODEL_IDS.terra,
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
      },
      {
        id: MODEL_IDS.sol,
        model: MODEL_IDS.sol,
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [
          { reasoningEffort: 'high', description: 'high policy' },
          { reasoningEffort: 'xhigh', description: 'xhigh policy' },
          { reasoningEffort: 'ultra', description: 'ultra policy' },
        ],
      },
    ],
  };
}

test('doctor model policy requires and names all seven exact worker pairs', () => {
  const result = evaluateWorkerModelCatalog(modelCatalog());
  assert.equal(result.status, 'pass');
  for (const pair of [
    'Luna Medium',
    'Terra Medium',
    'Terra High',
    'Terra XHigh',
    'Sol High',
    'Sol XHigh',
    'Sol Ultra',
  ]) {
    assert.match(result.detail, new RegExp(pair));
  }
});

test('doctor fails readiness when any exact worker model/effort pair is missing', () => {
  const catalog = modelCatalog();
  catalog.data
    .find((model) => model.id === MODEL_IDS.sol)
    .supportedReasoningEfforts.pop();
  const result = evaluateWorkerModelCatalog(catalog);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /worker selection is blocked/);
  assert.match(result.detail, /Sol Ultra/);
  assert.doesNotMatch(result.detail, /fallback|warn/iu);
});

test('doctor fails closed on an invalid or unreadable model catalog shape', () => {
  const result = evaluateWorkerModelCatalog({ data: [{ id: MODEL_IDS.terra }] });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /catalog is invalid/);
  assert.match(result.detail, /worker selection is blocked/);
});

test('treats an unprefixed phrase as a start request', () => {
  const parsed = parseArgs(['migrate', 'safely']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.prompt, 'migrate safely');
});

test('preserves prompt whitespace supplied in a single terminal argument', () => {
  const parsed = parseArgs(['  preserve me  \n']);
  assert.equal(parsed.prompt, '  preserve me  \n');
});

test('rejects machine JSON on the streaming start command', () => {
  assert.throws(() => parseArgs(['--json', 'ship it']), /doctor/);
});

test('help and version execute without starting app-server', () => {
  const cli = resolve('scripts/cruise.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Start Cruise/);
  assert.match(help.stdout, /Up\/Down/);
  for (const skill of PUBLIC_SKILLS) assert.match(help.stdout, new RegExp(`\\$cruise:${skill}`));
  assert.doesNotMatch(help.stdout, /provision/i);

  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), CLI_VERSION);
});

test('a symlinked CLI path still executes the entrypoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-cli-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = resolve('scripts/cruise.mjs');
  const linkedCli = join(directory, 'cruise');
  await symlink(cli, linkedCli);

  const version = spawnSync(process.execPath, [linkedCli, '--version'], {
    encoding: 'utf8',
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), CLI_VERSION);
});

test('shared free-text input propagates typed cancellation', async () => {
  const input = new PassThrough();
  const lineReader = createLineReader({ input });
  const pending = readLineOnce({
    prompt: 'Other: ',
    input,
    output: { write() { return true; } },
    lineReader,
  });
  lineReader.cancel('ctrl-c');
  await assert.rejects(
    pending,
    (error) => error.code === 'CRUISE_INPUT_CANCELLED',
  );
});
