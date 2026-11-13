import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { doctorProbeTimeoutMs, runDoctorCommand } from '../scripts/cruise.mjs';

test('Doctor probe wait is operator-configurable, including no deadline', () => {
  assert.equal(doctorProbeTimeoutMs('0'), 0);
  assert.equal(doctorProbeTimeoutMs('180000'), 180000);
  for (const value of [-1, 1.5, Infinity, '30s', 2147483648]) {
    assert.throws(() => doctorProbeTimeoutMs(value), /CRUISE_DOCTOR_PROBE_TIMEOUT_MS/u);
  }
});
test('Doctor preserves delayed successful output when its deadline is disabled', () => {
  const result = runDoctorCommand(process.execPath, ['-e', "setTimeout(() => console.log('probe-ready'), 80)"], { timeoutMs: 0 });
  assert.equal(result.status, 0);
  assert.equal(result.output, 'probe-ready');
});
test('Doctor still bounds a genuinely unresponsive probe when a deadline is selected', () => {
  const result = runDoctorCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 30 });
  assert.equal(result.status, null);
  assert.match(result.error, /ETIMEDOUT/u);
});

test('public Doctor CLI uses the real probe binding and reports structured failures', async (t) => {
  const bin = await mkdtemp(join(tmpdir(), 'cruise-doctor-cli-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const codex = join(bin, 'codex');
  await writeFile(codex, `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' 'codex-fixture' ;;
  app-server) printf '%s\\n' 'fixture app-server help' ;;
  plugin) printf '%s\\n' '{"installed":[]}' ;;
  *) exit 2 ;;
esac
`);
  await chmod(codex, 0o755);
  const cli = fileURLToPath(new URL('../scripts/cruise.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provider, 'codex');
  assert.equal(report.checks.find(({ id }) => id === 'codex').status, 'pass');
  assert.match(report.checks.find(({ id }) => id === 'codex-plugin').detail, /not installed/u);
  assert.doesNotMatch(result.stderr, /command is not defined/u);
});
