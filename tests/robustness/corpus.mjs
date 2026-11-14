// Synthetic session-derived inputs only. No native transcript or credential is read.
import { mutateScenario, random } from './transforms.mjs';
export const NOT_EVALUATED = Object.freeze([
  'Native authentication expiry, sign-in, MFA, billing, or account recovery',
  'Real model reasoning, gradient attacks, or proof of goal alignment',
  'Native workspace routing, Seatbelt/OS isolation, and credential-copy prevention',
  'Concurrent real host sessions, peer-message delivery, and remote queue delivery',
  'Whole-machine profile effects and real network/provider availability',
  'Automatic context compaction, native 90-percent usage triggers, or compaction control',
  'Explicit owner-authorized relay reconciliation and authoritative native approval rejection',
]);

export const SCENARIOS = Object.freeze([
  ...['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']
    .map((method) => ({ adapter: 'approval', family: 'owner-decisions', variant: 'eof', method, critical: true })),
  ...['decline', 'cancel', 'acceptForSession', 'structured'].map((variant) =>
    ({ adapter: 'approval', family: 'owner-decisions', variant, critical: true })),
  ...[
    ['HTTP 401 authentication failed', 'upstream', 401],
    ['HTTP 402 billing required', 'upstream', 402],
    ['HTTP 429 quota exhausted', 'upstream', 429],
    ['upstream failed', 'upstream', 503],
    ['workspace routing discovery failed', 'unknown', null],
    ['refresh_token_revoked', 'unknown', null],
    ['getaddrinfo ENOTFOUND synthetic.invalid', 'dns', null],
    ['socket hang up ECONNRESET', 'connection', null],
  ].map(([message, category, status]) =>
    ({ adapter: 'classification', family: 'failure-attribution', message, category, status })),
  ...['start', 'thread/start', 'turn/start'].flatMap((stage) => ['exit', 'terminal'].map((event) =>
    ({ adapter: 'worker-startup', family: 'startup-lifecycle', stage, event, critical: true }))),
  ...[false, true].map((effects) =>
    ({ adapter: 'worker-startup', family: 'startup-lifecycle', stage: 'turn/start', event: 'exit', retry: true, effects, critical: true })),
  ...['execute', 'plan-only', 'temporal-implement', 'quoted-plan'].map((variant) => ({ adapter: 'goal-intent', family: 'goal-execution-intent', variant, planOnly: variant === 'plan-only', critical: true })),
  ...['risk-in-option', 'scope-in-header'].map((variant) =>
    ({ adapter: 'goal-authority', family: 'goal-authority', variant, critical: true })),
  ...['reordered-duplicate', 'closed', 'silent'].map((variant) =>
    ({ adapter: 'transport', family: 'transport-events', variant, critical: true })),
  ...['same-size', 'private-exclusions', 'escaping-symlink'].map((variant) =>
    ({ adapter: 'fingerprint', family: 'content-freshness', variant, critical: true })),
  ...['absent', 'stale'].map((variant) =>
    ({ adapter: 'flight', family: 'completion-evidence', variant, critical: true })),
  ...['latest', 'owner', 'task', 'progress', 'peer-pointer', 'fifo'].map((variant) =>
    ({ adapter: 'checkpoint', family: 'context-boundaries', variant, critical: true })),
  { adapter: 'package', family: 'package-boundary', variant: 'private-tree', critical: true },
  ...['worker', 'quick', 'build', 'goal'].flatMap((surface) => ['native-completion', 'native-denial'].map((variant) =>
    ({ adapter: 'permission-inheritance', family: 'host-permission-inheritance', surface, variant, critical: true }))),
]);

// Discovery and held-out use distinct values and mutation channels. Held-out is
// evaluated after discovery; it is not selected using the discovery result.
export function generateCases({ seed = 1729, discoverySeeds = 2, heldoutSeeds = 1 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('seed must be uint32');
  if (![discoverySeeds, heldoutSeeds].every((value) => Number.isInteger(value) && value >= 1 && value <= 5)) {
    throw new TypeError('discoverySeeds and heldoutSeeds must each be 1..5');
  }
  const cases = [];
  for (const [split, count] of [['discovery', discoverySeeds], ['heldout', heldoutSeeds]]) {
    for (let index = 0; index < count; index += 1) {
      const mutationSeed = (seed + index + (split === 'heldout' ? 0x9e3779b9 : 0)) >>> 0;
      const rng = random(mutationSeed);
      SCENARIOS.forEach((scenario, ordinal) => {
        cases.push(mutateScenario(scenario, { split, index, ordinal, seed: mutationSeed, rng }));
      });
    }
  }
  return cases;
}
