// The evaluator's own acceptance predicate is separate from target assertions.
// A clean process exit alone is never a successful case.
export function validateCaseArtifact({ child, text, nonce, testCase }) {
  if (child.error || child.signal) throw new Error(`Child did not join cleanly: ${child.error?.message ?? child.signal}`);
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('Missing or malformed case artifact'); }
  if (result?.schemaVersion !== 1 || result.nonce !== nonce || result.caseId !== testCase.id || result.adapter !== testCase.adapter) {
    throw new Error('Stale or mismatched case artifact');
  }
  if (!['pass', 'invariant_fail', 'harness_error'].includes(result.status)
    || !Array.isArray(result.observations) || result.observations.length === 0
    || !Number.isInteger(result.assertions) || result.assertions < 0
    || (result.status === 'pass' && result.assertions < 1)
    || typeof result.outcome !== 'string' || !result.outcome) throw new Error('Invalid case result predicate');
  if (child.status !== (result.status === 'pass' ? 0 : 1)) throw new Error('Exit status disagrees with case artifact');
  if (result.status === 'pass' && /UnhandledPromiseRejection|uncaughtException|ERR_UNHANDLED_REJECTION/u.test(child.stderr ?? '')) {
    throw new Error('Unhandled failure appeared alongside passing artifact');
  }
  return result;
}

export function summarize(results) {
  const families = {};
  for (const result of results) {
    const group = families[result.family] ??= { total: 0, pass: 0, invariant_fail: 0, harness_error: 0, contained_host_failure: 0, contained_native_denial: 0,
      discovery: { total: 0, failed: 0 }, heldout: { total: 0, failed: 0 }, criticalFailures: [] };
    group.total += 1; group[result.status] += 1; group[result.split].total += 1;
    if (result.status !== 'pass') group[result.split].failed += 1;
    if (result.outcome === 'contained_host_failure') group.contained_host_failure += 1;
    if (result.outcome === 'contained_native_denial') group.contained_native_denial += 1;
    if (result.critical && result.status !== 'pass') group.criticalFailures.push(result.id);
  }
  return { total: results.length, passed: results.filter((result) => result.status === 'pass').length,
    invariantFailures: results.filter((result) => result.status === 'invariant_fail').length,
    harnessErrors: results.filter((result) => result.status === 'harness_error').length,
    criticalWorstCaseFailures: results.filter((result) => result.critical && result.status !== 'pass').map((result) => result.id), families };
}
