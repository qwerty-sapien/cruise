import assert from 'node:assert/strict';
import test from 'node:test';
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
