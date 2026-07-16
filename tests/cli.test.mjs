import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CLI_VERSION,
  evaluateWorkerModelCatalog,
  inspectPathClient,
  parseArgs,
  pluginRuntimeStayedStable,
  probeModelCatalog,
  PUBLIC_SKILLS,
  readWorkerPacket,
  readLineOnce,
} from '../scripts/cruise.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { createLineReader } from '../scripts/lib/line-input.mjs';

test('parses direct prompt and start options', () => {
  const parsed = parseArgs(['start', '-C', '.', 'ship', 'it']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.skill, 'goal');
  assert.equal(parsed.cwd, resolve('.'));
  assert.equal(parsed.prompt, 'ship it');
});

test('parses public skills as automatic staged workflow commands', () => {
  for (const skill of PUBLIC_SKILLS) {
    const parsed = parseArgs([skill, '-C', '.', 'ship', 'it']);
    assert.equal(parsed.command, skill);
    assert.equal(parsed.skill, skill);
    assert.equal(parsed.cwd, resolve('.'));
    assert.equal(parsed.prompt, 'ship it');
  }
});

test('Build auto-approval becomes an immutable request header and is rejected elsewhere', () => {
  const parsed = parseArgs(['build', '--auto-approve', '-C', '.', 'establish', 'it']);
  assert.equal(parsed.autoApprove, true);
  assert.equal(parsed.prompt, '--auto-approve\n\nestablish it');
  assert.throws(
    () => parseArgs(['goal', '--auto-approve', 'ship it']),
    /supported only by `cruise build`/u,
  );
});

test('rejects root-model overrides because Cruise delegates model-specific work', () => {
  assert.throws(() => parseArgs(['--model', 'gpt-test', 'ship it']), /Unknown option/);
});

test('parses explicit troubleshoot Doctor and scoped rule installation options', () => {
  const parsed = parseArgs([
    'doctor',
    '--troubleshoot',
    '--install-worker-rule',
    '--fixture',
    '.',
    '--codex-home',
    '.',
    '--json',
  ]);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.troubleshoot, true);
  assert.equal(parsed.installWorkerRule, true);
  assert.equal(parsed.fixture, resolve('.'));
  assert.equal(parsed.codexHome, resolve('.'));
  assert.equal(parsed.json, true);
});

test('rejects a Doctor fixture without explicit troubleshoot mode', () => {
  assert.throws(() => parseArgs(['doctor', '--fixture', '.']), /requires `cruise doctor --troubleshoot`/u);
});

test('parses Git hook installation, events, and fixed Deep Doctor mode', () => {
  const install = parseArgs(['hooks', 'install', '-C', '.', '--json']);
  assert.equal(install.command, 'hooks');
  assert.equal(install.action, 'install');
  assert.equal(install.cwd, resolve('.'));
  assert.equal(install.json, true);

  const run = parseArgs(['hooks', 'run', '--event', 'post-rewrite', '-C', '.']);
  assert.equal(run.action, 'run');
  assert.equal(run.event, 'post-rewrite');

  const doctor = parseArgs(['doctor', '--deep']);
  assert.equal(doctor.deep, true);
  assert.throws(
    () => parseArgs(['doctor', '--deep', '--troubleshoot']),
    /mutually exclusive/u,
  );
  assert.throws(() => parseArgs(['doctor', '--deep-timeout-ms', '7200000']), /Unknown option/u);
});

test('parses Cruise class selector and non-interactive inspection', () => {
  const selector = parseArgs(['config', 'class', '--codex-home', '.']);
  assert.equal(selector.command, 'config');
  assert.equal(selector.action, 'class');
  assert.equal(selector.show, false);

  const show = parseArgs(['config', 'class', '--show', '--json', '--codex-home', '.']);
  assert.equal(show.show, true);
  assert.equal(show.json, true);
  assert.throws(
    () => parseArgs(['config', 'class', '--json']),
    /requires --show/u,
  );
});

test('parses the three communication-style choices and inspection', () => {
  const selected = parseArgs(['config', 'style', 'friendly', '--codex-home', '.']);
  assert.equal(selected.command, 'config');
  assert.equal(selected.action, 'style');
  assert.equal(selected.configValue, 'friendly');

  const shown = parseArgs(['config', 'style', '--show', '--json', '--codex-home', '.']);
  assert.equal(shown.show, true);
  assert.equal(shown.json, true);
  assert.throws(
    () => parseArgs(['config', 'style', 'default', '--show']),
    /Choose a style or use --show/u,
  );
});

test('communication style persists as a user-facing three-choice preference', async () => {
  const cli = resolve('scripts/cruise.mjs');
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-style-cli-'));
  const selected = spawnSync(
    process.execPath,
    [cli, 'config', 'style', 'friendly', '--codex-home', codexHome],
    { encoding: 'utf8' },
  );
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /Friendly and creative/u);

  const shown = spawnSync(
    process.execPath,
    [cli, 'config', 'style', '--show', '--json', '--codex-home', codexHome],
    { encoding: 'utf8' },
  );
  assert.equal(shown.status, 0, shown.stderr);
  const config = JSON.parse(shown.stdout);
  assert.equal(config.style, 'friendly');
  assert.equal(config.persisted, true);
});

test('Cruise class selector persists and show returns machine-readable state', async () => {
  const cli = resolve('scripts/cruise.mjs');
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-config-cli-'));
  const selected = spawnSync(
    process.execPath,
    [cli, 'config', 'class', '--codex-home', codexHome],
    { encoding: 'utf8', input: '3\n' },
  );
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /luxury-cruise: level 6 \(sol-X\)/u);

  const shown = spawnSync(
    process.execPath,
    [cli, 'config', 'class', '--show', '--json', '--codex-home', codexHome],
    { encoding: 'utf8' },
  );
  assert.equal(shown.status, 0, shown.stderr);
  const config = JSON.parse(shown.stdout);
  assert.equal(config.cruise_class, 'luxury-cruise');
  assert.equal(config.default_level, 6);
  assert.equal(config.persisted, true);
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

test('doctor rejects a same-tier model-version change without an exact catalog match', () => {
  const catalog = modelCatalog();
  for (const entry of catalog.data) {
    entry.id = entry.id.replace('gpt-5.6-', 'gpt-5.7-');
    entry.model = entry.model.replace('gpt-5.6-', 'gpt-5.7-');
  }
  const result = evaluateWorkerModelCatalog(catalog);
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /missing Luna Medium/u);
  assert.match(result.detail, /Terra XHigh/u);
  assert.match(result.detail, /Sol Ultra/u);
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

test('static Doctor model probe bounds a never-resolving model/list and stops its client', async () => {
  let stopCalls = 0;
  let runtimeOptions;
  const client = new EventEmitter();
  client.start = async () => {};
  client.request = () => new Promise(() => {});
  client.stop = () => {
    stopCalls += 1;
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  const result = await probeModelCatalog({
    timeoutMs: 20,
    codexHome: '/tmp/cruise-explicit-codex-home',
    async runtimeFactory(options) {
      runtimeOptions = options;
      return {
        appServerArgs: [],
        spawnOptions: {},
        async dispose() {},
      };
    },
    clientFactory() {
      return client;
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /Doctor model catalog probe exceeded 20ms during model\/list/u);
  assert.equal(stopCalls, 1);
  assert.deepEqual(runtimeOptions, {
    codexHome: '/tmp/cruise-explicit-codex-home',
    extensionProfile: 'worker',
  });
  assert.equal(Date.now() - startedAt < 500, true);
});

test('static Doctor model probe aborts a pending request on protocol error', async () => {
  let stopCalls = 0;
  let clientOptions;
  const client = new EventEmitter();
  client.start = async () => {};
  client.request = () => {
    queueMicrotask(() => clientOptions.onError(new Error('invalid model catalog JSON'), client));
    return new Promise(() => {});
  };
  client.stop = async () => {
    stopCalls += 1;
  };
  const startedAt = Date.now();
  const result = await probeModelCatalog({
    timeoutMs: 10_000,
    async runtimeFactory() {
      return {
        appServerArgs: [],
        spawnOptions: {},
        async dispose() {},
      };
    },
    clientFactory(options) {
      clientOptions = options;
      return client;
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /invalid model catalog JSON/u);
  assert.doesNotMatch(result.detail, /exceeded 10000ms/u);
  assert.equal(stopCalls >= 1, true);
  assert.equal(Date.now() - startedAt < 1_000, true);
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
  assert.match(help.stdout, /separate confirmation before starting/);
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

test('Doctor requires the PATH client to resolve to its running entrypoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-cli-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = resolve('scripts/cruise.mjs');
  const linkedCli = join(directory, 'cruise');
  await symlink(cli, linkedCli);

  const current = await inspectPathClient({ entrypoint: cli, pathValue: directory });
  assert.equal(current.status, 'pass');
  assert.match(current.detail, /resolves to the running Cruise entrypoint/u);

  await rm(linkedCli);
  await writeFile(linkedCli, '#!/bin/sh\nexit 0\n');
  await chmod(linkedCli, 0o755);
  const stale = await inspectPathClient({ entrypoint: cli, pathValue: directory });
  assert.equal(stale.status, 'fail');
  assert.match(stale.detail, /not the running Cruise entrypoint/u);
});

test('all app-server sandbox policies omit optional networkAccess overrides', async () => {
  for (const path of [
    'scripts/lib/worker-session.mjs',
    'scripts/lib/session.mjs',
    'scripts/lib/doctor-e2e.mjs',
  ]) {
    assert.doesNotMatch(await readFile(resolve(path), 'utf8'), /\bnetworkAccess\s*:/u, path);
  }
});

test('every public skill blocks on the complete Doctor result and digest identity', async () => {
  for (const skill of PUBLIC_SKILLS) {
    const contents = await readFile(resolve('skills', skill, 'SKILL.md'), 'utf8');
    assert.match(contents, /command exits zero and its top-level `ok` is `true`/u, skill);
    assert.match(contents, /`installed-plugin-digest`/u, skill);
    assert.match(contents, /`client-on-path`/u, skill);
    assert.match(contents, /every\s+other failed Doctor[\s\S]{0,80}blocking/u, skill);
    assert.match(contents, /absolute `workerExecutable`/u, skill);
    assert.match(contents, /never\s+use the PATH[\s\S]{0,40}token `cruise`/u, skill);
    assert.match(contents, /same\s+`\.cruise\/runs\/<run-id>` directory/u, skill);
  }
});

test('every public skill starts non-destructive monitoring without a speculative question', async () => {
  const shared = await readFile(resolve('internal/shared/invocation-contract.md'), 'utf8');
  assert.match(shared, /Start non-destructive foreign-diff monitoring automatically/u);
  assert.match(shared, /`foreign-diff-guard\.yaml` in `monitoring` state/u);
  assert.match(shared, /does not ask a start[\s\S]{0,20}question/u);
  assert.match(shared, /pre-existing dirty path/u);
  assert.match(shared, /never ask a\s+speculative repository-change question when no incident exists/u);
  assert.match(shared, /Cruise does not offer or apply restoration/u);
  assert.match(shared, /publishes the staged run as[\s\S]{0,40}blocked/u);
  assert.match(shared, /fresh Origin in a new run/u);
  assert.doesNotMatch(
    shared,
    /Preserve only \(recommended\)|Allow exact restore|foreign-diff-permission|awaiting_permission|restore_exact_changes/u,
  );

  for (const skill of PUBLIC_SKILLS) {
    const contents = await readFile(resolve('skills', skill, 'SKILL.md'), 'utf8');
    assert.match(contents, /automatically establish shared\s+non-destructive foreign-diff monitoring/u, skill);
    assert.match(contents, /Do not ask a\s+speculative start question/u, skill);
    assert.match(contents, /root-owned\s+incident pause protocol/u, skill);
    assert.match(contents, /after the concrete incident is persisted/u, skill);
    assert.match(contents, /fresh Origin in a new run/u, skill);
  }

  const execution = await readFile(
    resolve('skills/goal/references/execution-loop.md'),
    'utf8',
  );
  assert.doesNotMatch(execution, /Reject or quarantine changes outside assigned ownership/u);
});

test('semantic mapping contract requires the runtime-generated preflighted packet', async () => {
  const shared = await readFile(resolve('internal/shared/invocation-contract.md'), 'utf8');
  const quick = await readFile(resolve('skills/quick/SKILL.md'), 'utf8');
  for (const [label, contents] of [['shared contract', shared], ['Quick skill', quick]]) {
    assert.match(contents, /runtime-generated `semantic-mapping-packet\.yaml`|exact `semantic-mapping-packet\.yaml` generated atomically/u, label);
    assert.match(contents, /(?:do not|never) hand-write/iu, label);
    assert.match(contents, /enrichment_template/u, label);
    assert.match(contents, /facts\[\*\]\.value/u, label);
    assert.match(contents, /facts\[\*\]\.basis/u, label);
  }
});

test('deep Doctor stability binds final source, cache, and snapshot to the initial digest', () => {
  const initialDigest = 'a'.repeat(64);
  const stableInspection = {
    matches: true,
    source: { digest: initialDigest },
    cache: { digest: initialDigest },
  };
  assert.equal(pluginRuntimeStayedStable({
    initialDigest,
    inspection: stableInspection,
    snapshotInitialDigest: initialDigest,
    snapshotFinal: { digest: initialDigest },
  }), true);
  assert.equal(pluginRuntimeStayedStable({
    initialDigest,
    inspection: {
      matches: true,
      source: { digest: 'b'.repeat(64) },
      cache: { digest: 'b'.repeat(64) },
    },
    snapshotInitialDigest: initialDigest,
    snapshotFinal: { digest: initialDigest },
  }), false, 'matching source/cache replacements must still fail the initial digest fence');
  assert.equal(pluginRuntimeStayedStable({
    initialDigest,
    inspection: stableInspection,
    snapshotInitialDigest: 'c'.repeat(64),
    snapshotFinal: { digest: initialDigest },
  }), false, 'the staged snapshot must match at creation');
  assert.equal(pluginRuntimeStayedStable({
    initialDigest,
    inspection: stableInspection,
    snapshotInitialDigest: initialDigest,
    snapshotFinal: { digest: 'd'.repeat(64) },
  }), false, 'the staged snapshot must remain unchanged');
});


test('worker packet input remains bounded to four MiB', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-bounded-packet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packet = join(directory, 'packet.yaml');
  await writeFile(packet, 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(readWorkerPacket(packet), /exceeds 4194304 bytes/u);
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
