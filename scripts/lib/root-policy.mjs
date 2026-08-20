import { MODEL_IDS, resolveModelPolicy } from './model-policy.mjs';

export const ROOT_MODEL = MODEL_IDS.sol;
export const ROOT_REASONING_EFFORT = 'high';

const SOL_EFFORTS = new Set(['high', 'xhigh', 'ultra', 'max']);

function normalizedOverride(override) {
  if (override == null) return null;
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('root override must be an object');
  }
  const model = String(override.model ?? override.model_id ?? '').trim();
  const reasoningEffort = String(
    override.reasoning_effort ?? override.reasoningEffort ?? '',
  ).trim().toLowerCase();
  if (!model || !reasoningEffort) {
    throw new TypeError('root override requires model and reasoning_effort');
  }
  return { model, reasoningEffort };
}

function tierFor(model) {
  return Object.entries(MODEL_IDS).find(([, id]) => id === model)?.[0] ?? null;
}

export function selectRootRequest({ override = null, cheaperDiagnostic = false } = {}) {
  if (typeof cheaperDiagnostic !== 'boolean') {
    throw new TypeError('cheaperDiagnostic must be a boolean');
  }
  const requestedOverride = normalizedOverride(override);
  if (
    requestedOverride &&
    !cheaperDiagnostic &&
    (requestedOverride.model !== ROOT_MODEL || !SOL_EFFORTS.has(requestedOverride.reasoningEffort))
  ) {
    throw new Error('root override must be at least Sol high unless a cheaper diagnostic was explicit');
  }
  const model = requestedOverride?.model ?? ROOT_MODEL;
  const reasoningEffort = requestedOverride?.reasoningEffort ?? ROOT_REASONING_EFFORT;
  const tier = tierFor(model);
  if (!tier) throw new Error(`unsupported root model override: ${model}`);
  return Object.freeze({
    model,
    reasoning_effort: reasoningEffort,
    tier,
    source: requestedOverride ? 'user_override' : 'default',
    cheaper_diagnostic: cheaperDiagnostic,
  });
}

/** Resolve the explicit Goal-root pair without silently accepting a weaker host fallback. */
export function resolveRootPolicy({
  catalog = [],
  override = null,
  cheaperDiagnostic = false,
} = {}) {
  const request = selectRootRequest({ override, cheaperDiagnostic });
  const requestedModel = request.model;
  const requestedEffort = request.reasoning_effort;
  const tier = request.tier;

  const resolution = resolveModelPolicy({
    stage: 'goal_root_coordination',
    catalog,
    requested: { tier, reasoning_effort: requestedEffort },
  });
  if (
    resolution.degraded ||
    resolution.resolved.model !== requestedModel ||
    resolution.resolved.reasoning_effort !== requestedEffort
  ) {
    const error = new Error(
      `required root pair ${requestedModel}/${requestedEffort} is unavailable: ${resolution.degradation_reasons.join('; ')}`,
    );
    error.code = 'CRUISE_ROOT_POLICY_UNAVAILABLE';
    throw error;
  }
  return Object.freeze({
    schema_version: 1,
    kind: 'cruise_goal_root_policy',
    role: 'coordinator_integrator_final_reviewer',
    substantive_worker_work: false,
    cheaper_diagnostic: request.cheaper_diagnostic,
    requested: Object.freeze({
      model: requestedModel,
      reasoning_effort: requestedEffort,
      source: request.source,
    }),
    resolved: Object.freeze({
      model_id: resolution.resolved.model_id,
      model: resolution.resolved.model,
      reasoning_effort: resolution.resolved.reasoning_effort,
      source: resolution.resolved.source,
    }),
  });
}
