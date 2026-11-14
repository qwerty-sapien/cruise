import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const GATE_STATES = new Set([
  'pending',
  'passed',
  'failed',
  'unavailable',
  'not_applicable',
  'waived',
]);
const EVIDENCE_SOURCES = new Set([
  'command',
  'measurement',
  'review',
  'repository',
  'user-decision',
  'other',
]);

export const QUALITY_PROFILES = Object.freeze({
  core: Object.freeze([
    'intent',
    'functional-correctness',
    'regression',
    'failure-paths',
    'completion-review',
  ]),
  web: Object.freeze([
    'accessibility',
    'responsive-ui',
    'browser-runtime',
  ]),
  'backend-data': Object.freeze([
    'data-integrity',
    'security',
    'concurrency',
    'observability',
  ]),
  'cxx-hpc': Object.freeze([
    'complexity',
    'memory',
    'numerical-correctness',
    'performance-measurement',
    'toolchain-portability',
  ]),
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneLine(value, name, { required = false } = {}) {
  const resolved = value === undefined || value === null ? '' : value;
  if (typeof resolved !== 'string' || /[\r\n]/u.test(resolved)) {
    throw new TypeError(`${name} must be one line`);
  }
  if (required && !resolved.trim()) throw new TypeError(`${name} must not be empty`);
  return resolved;
}

function stringArray(value, name, { nonempty = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || /[\r\n]/u.test(item) || !item.trim())
  ) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  if (nonempty && value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (new Set(value).size !== value.length) throw new TypeError(`${name} must not contain duplicates`);
  return [...value];
}

function normalizeEvidence(value, name) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new TypeError(`${name} must be a mapping`);
  const observedAt = value.observed_at ?? null;
  if (observedAt !== null && (!Number.isSafeInteger(observedAt) || observedAt < 1)) {
    throw new TypeError(`${name}.observed_at must be a positive integer or null`);
  }
  const source = value.source;
  if (!EVIDENCE_SOURCES.has(source)) {
    throw new TypeError(`${name}.source must be an explicit supported evidence source`);
  }
  return {
    summary: oneLine(value.summary, `${name}.summary`),
    contextFingerprint: oneLine(value.context_fingerprint, `${name}.context_fingerprint`),
    observedAt,
    source,
    rationale: oneLine(value.rationale, `${name}.rationale`),
    waivedBy: oneLine(value.waived_by, `${name}.waived_by`),
    raw: value,
  };
}

function normalizeGate(value, index) {
  const name = `quality.gates[${index}]`;
  if (!isObject(value)) throw new TypeError(`${name} must be a mapping`);
  const state = value.state ?? 'pending';
  if (!GATE_STATES.has(state)) throw new TypeError(`${name}.state is unsupported`);
  const severity = value.severity ?? 'medium';
  if (!RISKS.has(severity)) throw new TypeError(`${name}.severity is unsupported`);
  return {
    id: oneLine(value.id, `${name}.id`, { required: true }),
    dimension: oneLine(value.dimension, `${name}.dimension`, { required: true }),
    criterion: oneLine(value.criterion, `${name}.criterion`, { required: true }),
    oracle: oneLine(value.oracle, `${name}.oracle`, { required: true }),
    severity,
    state,
    evidence: normalizeEvidence(value.evidence, `${name}.evidence`),
    raw: value,
  };
}

export function normalizeQuality(value, version) {
  if (version < 2) return null;
  if (!isObject(value)) throw new TypeError('quality must be a mapping for Flight v2');
  const risk = value.risk ?? 'medium';
  if (!RISKS.has(risk)) throw new TypeError('quality.risk is unsupported');
  const profiles = stringArray(value.profiles, 'quality.profiles', { nonempty: true });
  if (!profiles.includes('core')) throw new TypeError('quality.profiles must include core');
  for (const profile of profiles) {
    if (!Object.hasOwn(QUALITY_PROFILES, profile)) {
      throw new TypeError(`quality profile ${profile} is unsupported`);
    }
  }
  const gates = value.gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    throw new TypeError('quality.gates must be a non-empty array');
  }
  const normalizedGates = gates.map(normalizeGate);
  if (new Set(normalizedGates.map((gate) => gate.id)).size !== normalizedGates.length) {
    throw new TypeError('quality.gates must use unique ids');
  }
  return { risk, profiles, gates: normalizedGates, raw: value };
}

export function serializeQuality(quality) {
  if (!quality) return undefined;
  const raw = isObject(quality.raw) ? quality.raw : {};
  const gates = quality.gates.map((gate) => {
    const gateRaw = isObject(gate.raw) ? gate.raw : {};
    const evidenceRaw = isObject(gate.evidence?.raw) ? gate.evidence.raw : {};
    return {
      ...gateRaw,
      id: gate.id,
      dimension: gate.dimension,
      criterion: gate.criterion,
      oracle: gate.oracle,
      severity: gate.severity,
      state: gate.state,
      ...(gate.evidence === null
        ? { evidence: null }
        : {
            evidence: {
              ...evidenceRaw,
              summary: gate.evidence.summary,
              context_fingerprint: gate.evidence.contextFingerprint,
              observed_at: gate.evidence.observedAt,
              source: gate.evidence.source,
              rationale: gate.evidence.rationale,
              waived_by: gate.evidence.waivedBy,
            },
          }),
    };
  });
  return {
    ...raw,
    risk: quality.risk,
    profiles: quality.profiles,
    gates,
  };
}

function contractFor(plan) {
  return {
    outcome: plan.outcome,
    verify: plan.verify,
    scope: {
      touchpoints: plan.scope.touchpoints,
      non_goals: plan.scope.nonGoals,
    },
    invariants: plan.invariants,
    quality: {
      risk: plan.quality.risk,
      profiles: plan.quality.profiles,
      gates: plan.quality.gates.map((gate) => ({
        id: gate.id,
        dimension: gate.dimension,
        criterion: gate.criterion,
        oracle: gate.oracle,
        severity: gate.severity,
      })),
    },
    body: plan.body,
  };
}

export function computeFlightContextFingerprint(plan, {
  workspaceFingerprint,
  originText = null,
} = {}) {
  if (!plan || plan.version < 2 || !plan.quality) {
    throw new TypeError('a valid Flight v2 plan is required');
  }
  if (typeof workspaceFingerprint !== 'string' || !workspaceFingerprint) {
    throw new TypeError('workspaceFingerprint is required');
  }
  if (typeof originText !== 'string' || !originText.trim()) {
    throw new TypeError('a non-empty .cruise/ORIGIN.md request binding is required');
  }
  const originBinding = `origin:present:${digest(originText)}`;
  return digest(JSON.stringify({
    origin: originBinding,
    workspace: workspaceFingerprint,
    contract: contractFor(plan),
  }));
}

export async function captureFlightContextFingerprint(cwd, plan, {
  workspaceFingerprint,
} = {}) {
  let originText;
  try {
    originText = await readFile(join(cwd, '.cruise', 'ORIGIN.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Cruise cannot attest Flight v2 without .cruise/ORIGIN.md');
    }
    throw error;
  }
  return computeFlightContextFingerprint(plan, { workspaceFingerprint, originText });
}

function requiredDimensions(quality) {
  const dimensions = new Set(
    quality.profiles.flatMap((profile) => QUALITY_PROFILES[profile]),
  );
  if (quality.risk === 'high' || quality.risk === 'critical') dimensions.add('independent-review');
  return dimensions;
}

export function evaluateFlightAssurance(plan, contextFingerprint) {
  if (!plan || typeof plan !== 'object') throw new TypeError('flight plan is required');
  if (plan.version < 2) {
    return Object.freeze({
      level: 'legacy-unattested',
      contractClosed: false,
      readyForCompletion: false,
      allowsCompletion: false,
      reasons: Object.freeze([
        'Flight v1 has no evidence-bound assurance contract; migrate it to Flight v2 before completion.',
      ]),
      progressFingerprint: digest(JSON.stringify({ version: plan.version, status: plan.status })),
      metrics: Object.freeze({ total: 0, closed: 0, fresh: 0, passed: 0, waived: 0 }),
      gates: Object.freeze([]),
    });
  }

  const dimensions = requiredDimensions(plan.quality);
  const missingDimensions = [...dimensions].filter((dimension) =>
    !plan.quality.gates.some((gate) => gate.dimension === dimension));
  const gateResults = plan.quality.gates.map((gate) => {
    const evidence = gate.evidence;
    const fresh = Boolean(
      evidence &&
      contextFingerprint &&
      evidence.contextFingerprint === contextFingerprint &&
      Number.isSafeInteger(evidence.observedAt),
    );
    let closed = false;
    let reason = null;
    const summaryPresent = Boolean(evidence?.summary?.trim());
    const rationalePresent = Boolean(evidence?.rationale?.trim());
    const mustPass = [
      'intent',
      'functional-correctness',
      'completion-review',
      'independent-review',
    ].includes(gate.dimension);
    if (gate.state === 'passed') {
      closed = fresh && summaryPresent && evidence?.source !== 'user-decision';
      if (!closed) reason = fresh
        ? 'passed evidence needs a summary and a non-user-decision source'
        : 'passed evidence is absent or stale';
    } else if (gate.state === 'not_applicable') {
      closed = !mustPass && fresh && rationalePresent;
      if (!closed) reason = fresh
        ? mustPass
          ? `${gate.dimension} must pass and cannot be marked not applicable`
          : 'not-applicable evidence needs a non-empty rationale'
        : 'not-applicable evidence is absent or stale';
    } else if (gate.state === 'waived') {
      closed = !mustPass &&
        fresh &&
        rationalePresent &&
        evidence?.source === 'user-decision' &&
        evidence?.waivedBy === 'user';
      if (!closed) reason = fresh
        ? mustPass
          ? `${gate.dimension} must pass and cannot be waived`
          : 'waiver needs user-decision evidence, a non-empty rationale, and waived_by: user'
        : 'waiver evidence is absent or stale';
    } else {
      reason = `gate state is ${gate.state}`;
    }
    if (
      gate.dimension === 'independent-review' &&
      (plan.quality.risk === 'high' || plan.quality.risk === 'critical')
    ) {
      closed = closed && gate.state === 'passed' && evidence?.source === 'review';
      if (!closed) reason = 'high-risk independent review must freshly pass with review evidence';
    }
    if (gate.dimension === 'completion-review') {
      closed = closed && gate.state === 'passed' && evidence?.source === 'review';
      if (!closed) reason = 'completion review must freshly pass with review evidence';
    }
    return Object.freeze({
      id: gate.id,
      dimension: gate.dimension,
      state: gate.state,
      fresh,
      closed,
      reason,
    });
  });
  const reasons = [
    ...missingDimensions.map((dimension) => `missing required ${dimension} gate`),
    ...gateResults.filter((gate) => !gate.closed).map((gate) => `${gate.id}: ${gate.reason}`),
  ];
  const waived = gateResults.filter((gate) => gate.closed && gate.state === 'waived').length;
  const allClosed = missingDimensions.length === 0 && gateResults.every((gate) => gate.closed);
  const level = !allClosed
    ? 'incomplete'
    : waived > 0
      ? 'qualified'
      : 'assured';
  const metrics = Object.freeze({
    total: gateResults.length,
    closed: gateResults.filter((gate) => gate.closed).length,
    fresh: gateResults.filter((gate) => gate.fresh).length,
    passed: gateResults.filter((gate) => gate.closed && gate.state === 'passed').length,
    waived,
  });
  const progressFingerprint = digest(JSON.stringify({
    dimensions: [...dimensions].sort(),
    missingDimensions: missingDimensions.sort(),
    gates: gateResults.map((gate) => ({
      id: gate.id,
      state: gate.state,
      fresh: gate.fresh,
      closed: gate.closed,
    })),
  }));
  return Object.freeze({
    level,
    contractClosed: allClosed,
    readyForCompletion: allClosed,
    allowsCompletion: plan.status === 'complete' && allClosed,
    reasons: Object.freeze(reasons),
    progressFingerprint,
    metrics,
    gates: Object.freeze(gateResults),
  });
}
