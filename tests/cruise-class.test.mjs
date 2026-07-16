import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CRUISE_CLASSES,
  cruiseClassInstructions,
  cruiseClassPath,
  readCruiseClass,
  resolveNativeCruiseHost,
  writeCruiseClass,
} from '../scripts/lib/cruise-class.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';

function catalog() {
  return {
    data: [
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
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
      },
    ],
  };
}

test('missing class config defaults to normal cruise level 4 without writing', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-class-default-'));
  const config = await readCruiseClass({ codexHome });

  assert.equal(config.cruise_class, 'normal-cruise');
  assert.equal(config.default_level, 4);
  assert.equal(config.default_alias, 'terra-X');
  assert.equal(config.persisted, false);
});

test('all four classes persist their canonical levels and scope', async () => {
  const expected = {
    'budget-cruise': 3,
    'normal-cruise': 4,
    'premium-cruise': 5,
    'luxury-cruise': 6,
  };
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-class-write-'));

  for (const [cruiseClass, level] of Object.entries(expected)) {
    const saved = await writeCruiseClass(cruiseClass, {
      codexHome,
      now: () => new Date('2026-07-16T00:00:00.000Z'),
    });
    const loaded = await readCruiseClass({ codexHome });
    assert.equal(saved.default_level, level);
    assert.equal(loaded.cruise_class, cruiseClass);
    assert.equal(loaded.default_level, level);
    assert.equal(loaded.host_scope.native_cruise, 'host_and_subagents');
    assert.equal(loaded.host_scope.codex_cli_or_gui, 'subagents_only');
  }

  assert.deepEqual(Object.keys(CRUISE_CLASSES), Object.keys(expected));
});

test('native host resolves the exact class pair while external instructions limit host claims', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-class-native-'));
  const premium = await writeCruiseClass('premium-cruise', { codexHome });
  const host = resolveNativeCruiseHost(premium, catalog());

  assert.equal(host.level, 5);
  assert.equal(host.model, MODEL_IDS.sol);
  assert.equal(host.reasoning_effort, 'high');
  assert.match(cruiseClassInstructions(premium), /subagent defaults only.*never claims to change the host model/u);
  assert.match(cruiseClassInstructions(premium, { nativeHost: true }), /native Cruise host is also pinned to level 5/u);
});

test('invalid or internally inconsistent persisted config fails closed', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-class-invalid-'));
  const path = cruiseClassPath({ codexHome });
  await writeCruiseClass('normal-cruise', { codexHome });
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  parsed.default_level = 6;
  await writeFile(path, `${JSON.stringify(parsed)}\n`);

  await assert.rejects(readCruiseClass({ codexHome }), /level does not match normal-cruise/u);
});
