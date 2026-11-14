import { writeFile } from 'node:fs/promises';
import { executeCase } from './adapters.mjs';

const [encoded, target, root, artifact, nonce] = process.argv.slice(2);
const testCase = JSON.parse(encoded);
// Keeps unref'ed production watchdogs observable; bounded by the parent's hard
// timeout. This timer is always cleared after an adapter settles.
const keepAlive = setInterval(() => {}, 1000);
let result;
try {
  const observation = await executeCase(testCase, { target, root });
  result = { status: 'pass', ...observation };
} catch (error) {
  result = { status: error.code === 'ERR_ASSERTION' ? 'invariant_fail' : 'harness_error',
    assertions: 0, outcome: 'not_completed', observations: [{ name: error.name, code: error.code ?? null,
      message: error.message, expected: error.expected, actual: error.actual }], stack: error.stack };
} finally { clearInterval(keepAlive); }
await writeFile(artifact, JSON.stringify({ schemaVersion: 1, nonce, caseId: testCase.id, adapter: testCase.adapter, ...result }, null, 2) + '\n');
process.exitCode = result.status === 'pass' ? 0 : 1;
