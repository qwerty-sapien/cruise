import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appServerExtensionArgs,
  appServerDiagnostic,
  configuredMcpServerNames,
  createIsolatedAppServerRuntime,
  WORKER_HOST_PATH_LOST,
  WORKER_INFERENCE_STREAM_FAILED,
  workerConnectionDiagnostic,
} from '../scripts/lib/app-server-runtime.mjs';

test('isolates writable app-server state while retaining the required Codex control snapshot', async (t) => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'cruise-runtime-source-'));
  t.after(() => rm(sourceHome, { recursive: true, force: true }));
  await mkdir(join(sourceHome, 'agents'));
  await mkdir(join(sourceHome, 'accounts'));
  await mkdir(join(sourceHome, 'rules'));
  await writeFile(join(sourceHome, 'config.toml'), 'model = "test"\n');
  await writeFile(join(sourceHome, 'auth.json'), '{"access_token":"test"}\n');
  await writeFile(join(sourceHome, '.codex-global-state.json'), '{"account":"test"}\n');
  await writeFile(join(sourceHome, 'installation_id'), 'test-installation\n');
  await writeFile(join(sourceHome, 'agents', 'cruise_l1.toml'), 'name = "worker"\n');
  await writeFile(join(sourceHome, 'accounts', 'registry.json'), '{"active":"test"}\n');
  await writeFile(join(sourceHome, 'rules', 'cruise-worker.rules'), 'prefix_rule(pattern=["cruise", "worker"], decision="allow")\n');

  const runtime = await createIsolatedAppServerRuntime({ codexHome: sourceHome });
  assert.notEqual(runtime.codexHome, sourceHome);
  assert.equal(runtime.spawnOptions.env.CODEX_HOME, runtime.codexHome);
  assert.equal(await readFile(join(runtime.codexHome, 'config.toml'), 'utf8'), 'model = "test"\n');
  assert.equal(await readFile(join(runtime.codexHome, 'auth.json'), 'utf8'), '{"access_token":"test"}\n');
  assert.equal(await readFile(join(runtime.codexHome, 'agents', 'cruise_l1.toml'), 'utf8'), 'name = "worker"\n');
  assert.equal(await readFile(join(runtime.codexHome, 'accounts', 'registry.json'), 'utf8'), '{"active":"test"}\n');
  assert.equal(
    await readFile(join(runtime.codexHome, 'rules', 'cruise-worker.rules'), 'utf8'),
    'prefix_rule(pattern=["cruise", "worker"], decision="allow")\n',
  );

  await writeFile(join(runtime.codexHome, 'config.toml'), 'model = "changed"\n');
  assert.equal(await readFile(join(sourceHome, 'config.toml'), 'utf8'), 'model = "test"\n');
  await runtime.dispose();
  await assert.rejects(access(runtime.codexHome));
});

test('only surfaces safe app-server configuration and sandbox diagnostics', () => {
  assert.equal(
    appServerDiagnostic('warning\nError: failed to initialize sqlite state runtime under /Users/example/.codex\n'),
    'app-server: Error: failed to initialize sqlite state runtime under /Users/example/.codex',
  );
  assert.equal(appServerDiagnostic('Bearer sensitive-token\n'), null);
  assert.equal(workerConnectionDiagnostic(new Error('Reconnecting... 2/5')), null);
  assert.equal(
    workerConnectionDiagnostic(new Error('stream disconnected before completion: error sending request for url (https://example.invalid/codex/responses)')),
    WORKER_INFERENCE_STREAM_FAILED,
  );
  assert.equal(
    workerConnectionDiagnostic(new Error('Codex app-server connection reset by peer')),
    WORKER_HOST_PATH_LOST,
  );
  assert.equal(
    workerConnectionDiagnostic(new Error('app-server exited before worker turn completed')),
    WORKER_HOST_PATH_LOST,
  );
  assert.match(WORKER_HOST_PATH_LOST, /cruise doctor --deep/u);
  assert.match(WORKER_INFERENCE_STREAM_FAILED, /retry budget/u);
  assert.doesNotMatch(WORKER_HOST_PATH_LOST, /authoriz|transmit|repository content/iu);
  assert.doesNotMatch(WORKER_INFERENCE_STREAM_FAILED, /authoriz|transmit|repository content/iu);
});

test('worker runtime preserves inherited plugins, Apps, MCP servers, and guardrails', async (t) => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'cruise-worker-runtime-source-'));
  t.after(() => rm(sourceHome, { recursive: true, force: true }));
  await writeFile(join(sourceHome, 'config.toml'), [
    '[mcp_servers.zeta]',
    'command = "zeta"',
    '[mcp_servers.alpha]',
    'command = "alpha"',
    '[mcp_servers.alpha.env]',
    'TOKEN = "redacted"',
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
    '',
  ].join('\n'));
  const runtime = await createIsolatedAppServerRuntime({
    codexHome: sourceHome,
    extensionProfile: 'worker',
  });
  t.after(() => runtime.dispose());
  assert.deepEqual(runtime.extensionPolicy, {
    profile: 'worker',
    plugins: 'inherited',
    apps: 'inherited',
    mcp_servers: 'inherited',
    native_guardrails: 'inherited',
    disabled_mcp_servers: [],
  });
  assert.deepEqual(runtime.appServerArgs, []);
  assert.match(await readFile(join(runtime.codexHome, 'config.toml'), 'utf8'), /mcp_servers\.alpha/u);
  assert.match(await readFile(join(runtime.codexHome, 'config.toml'), 'utf8'), /browser@openai-bundled/u);
});

test('Doctor discovery runtime keeps the full inherited Codex configuration', async (t) => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-source-'));
  t.after(() => rm(sourceHome, { recursive: true, force: true }));
  await writeFile(join(sourceHome, 'config.toml'), [
    '[mcp_servers.docs]',
    'url = "https://example.invalid"',
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
    '',
  ].join('\n'));
  const runtime = await createIsolatedAppServerRuntime({
    codexHome: sourceHome,
    extensionProfile: 'doctor-discovery',
  });
  t.after(() => runtime.dispose());
  assert.equal(
    await readFile(join(runtime.codexHome, 'config.toml'), 'utf8'),
    [
      '[mcp_servers.docs]',
      'url = "https://example.invalid"',
      '[plugins."browser@openai-bundled"]',
      'enabled = true',
      '',
    ].join('\n'),
  );
  assert.deepEqual(runtime.extensionPolicy, {
    profile: 'doctor-discovery',
    plugins: 'inherited',
    apps: 'inherited',
    mcp_servers: 'inherited',
    native_guardrails: 'inherited',
    disabled_mcp_servers: [],
  });
  assert.deepEqual(runtime.appServerArgs, []);
});

test('extension argument construction rejects unsafe MCP config names', () => {
  assert.deepEqual(configuredMcpServerNames([
    '[ mcp_servers.safe-name ]',
    '[ "mcp_servers" . "double-quoted" . env ]',
    "[ 'mcp_servers' . 'literal-quoted' ]",
    '"mcp_servers" . "dotted-key" . command = "worker"',
    '',
  ].join('\n')), ['dotted-key', 'double-quoted', 'literal-quoted', 'safe-name']);
  assert.throws(
    () => configuredMcpServerNames('[mcp_servers."unsafe.name"]\n'),
    /cannot safely disable an unsupported mcp_servers TOML declaration/u,
  );
  assert.throws(() => appServerExtensionArgs('worker', ['safe;bad']), /safe Codex config identifiers/u);
  assert.throws(() => appServerExtensionArgs('unknown'), /unknown app-server extension profile/u);
});
