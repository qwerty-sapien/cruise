import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMMUNICATION_STYLES,
  communicationStyleInstructions,
  communicationStylePath,
  readCommunicationStyle,
  writeCommunicationStyle,
} from '../scripts/lib/communication-style.mjs';

test('communication style defaults to clear language and persists only one of three enums', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-style-default-'));
  const initial = await readCommunicationStyle({ codexHome });
  assert.equal(initial.style, 'default');
  assert.equal(initial.persisted, false);
  assert.deepEqual(Object.keys(COMMUNICATION_STYLES), ['default', 'professional', 'friendly']);

  const saved = await writeCommunicationStyle('professional', {
    codexHome,
    now: () => new Date('2026-07-16T00:00:00.000Z'),
  });
  assert.equal(saved.style, 'professional');
  assert.match(communicationStyleInstructions(saved), /professional technical style/u);
  assert.equal((await readCommunicationStyle({ codexHome })).style, 'professional');
});

test('invalid persisted communication preference fails closed', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-style-invalid-'));
  const path = communicationStylePath({ codexHome });
  await writeCommunicationStyle('default', { codexHome });
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  parsed.style = 'unclear';
  await writeFile(path, `${JSON.stringify(parsed)}\n`);
  await assert.rejects(readCommunicationStyle({ codexHome }), /must be one of/u);
});
