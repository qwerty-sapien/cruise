const EFFORT_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'ultra', 'max']);

export const MODEL_IDS = Object.freeze({
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  astra: 'gpt-6-astra',
});

export const MODEL_POLICY_DEFAULTS = Object.freeze({
  initial_classification: Object.freeze({ tier: 'luna', reasoning_effort: 'medium' }),
  bounded_repository_mapping: Object.freeze({ tier: 'terra', reasoning_effort: 'xhigh' }),
  capability_inventory: Object.freeze({ tier: 'terra', reasoning_effort: 'xhigh' }),
  quick_implementation: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  quick_verification: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  goal_clarification_and_planning: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  normal_planned_execution: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  independent_normal_verification: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  debug_hypothesis_generation: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  difficult_debug_or_failed_normal_execution: Object.freeze({ tier: 'astra', reasoning_effort: 'high' }),
  architectural_or_consequential_implementation: Object.freeze({ tier: 'astra', reasoning_effort: 'high' }),
  repeated_failure_or_exceptional_consequence: Object.freeze({ tier: 'sol', reasoning_effort: 'ultra' }),
  research_retrieval_and_extraction: Object.freeze({ tier: 'terra', reasoning_effort: 'xhigh' }),
  research_synthesis_and_recommendation: Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  high_conflict_or_frontier_research: Object.freeze({ tier: 'astra', reasoning_effort: 'high' }),
  routine_structured_scans: Object.freeze({ tier: 'terra', reasoning_effort: 'xhigh' }),
});

const CATALOG_FIELDS = Object.freeze([
  'id',
  'model',
  'hidden',
  'isDefault',
  'defaultReasoningEffort',
  'supportedReasoningEfforts',
]);

function normalizeEffort(value, label = 'reasoning effort') {
  const effort = String(value ?? '').trim().toLowerCase();
  if (!EFFORT_ORDER.includes(effort)) {
    throw new TypeError(`${label} must be one of ${EFFORT_ORDER.join(', ')}`);
  }
  return effort;
}

function normalizeAdvertisedEffort(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeEffort(
      value.reasoningEffort ?? value.reasoning_effort,
      label,
    );
  }
  return normalizeEffort(value, label);
}

function normalizeTier(value) {
  const tier = String(value ?? '').trim().toLowerCase();
  if (!Object.hasOwn(MODEL_IDS, tier)) {
    throw new TypeError(`model tier must be one of ${Object.keys(MODEL_IDS).join(', ')}`);
  }
  return tier;
}

function catalogEntries(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (Array.isArray(catalog?.models)) return catalog.models;
  if (Array.isArray(catalog?.data)) return catalog.data;
  if (catalog == null) return [];
  throw new TypeError('model catalog must be an array or contain a models/data array');
}

/** Validate and normalize the model/list shape exposed by Codex app-server. */
export function normalizeModelCatalog(catalog) {
  return catalogEntries(catalog).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`model catalog entry ${index} must be an object`);
    }
    for (const field of CATALOG_FIELDS) {
      if (!Object.hasOwn(entry, field)) {
        throw new TypeError(`model catalog entry ${index} is missing ${field}`);
      }
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new TypeError(`model catalog entry ${index}.id must be a non-empty string`);
    }
    if (typeof entry.model !== 'string' || !entry.model.trim()) {
      throw new TypeError(`model catalog entry ${index}.model must be a non-empty string`);
    }
    if (typeof entry.hidden !== 'boolean' || typeof entry.isDefault !== 'boolean') {
      throw new TypeError(`model catalog entry ${index} hidden/isDefault must be booleans`);
    }
    if (!Array.isArray(entry.supportedReasoningEfforts) || entry.supportedReasoningEfforts.length === 0) {
      throw new TypeError(
        `model catalog entry ${index}.supportedReasoningEfforts must be a non-empty array`,
      );
    }
    const supported = [...new Set(entry.supportedReasoningEfforts.map((effort) => normalizeAdvertisedEffort(
      effort,
      `model catalog entry ${index} reasoning effort`,
    )))];
    const defaultEffort = normalizeEffort(
      entry.defaultReasoningEffort,
      `model catalog entry ${index} default reasoning effort`,
    );
    if (!supported.includes(defaultEffort)) {
      throw new TypeError(
        `model catalog entry ${index} default reasoning effort is not supported`,
      );
    }
    return Object.freeze({
      id: entry.id.trim(),
      model: entry.model.trim(),
      hidden: entry.hidden,
      isDefault: entry.isDefault,
      defaultReasoningEffort: defaultEffort,
      supportedReasoningEfforts: Object.freeze(supported),
    });
  });
}

function visibleEntries(catalog) {
  return normalizeModelCatalog(catalog).filter((entry) => !entry.hidden);
}

function findRequested(entries, requestedModel) {
  return entries.find(
    (entry) => entry.id === requestedModel || entry.model === requestedModel,
  ) ?? null;
}

function chooseFallback(entries) {
  return entries.find((entry) => entry.isDefault) ?? entries[0] ?? null;
}

function resolveEffort(entry, requestedEffort) {
  if (!entry) {
    return {
      effort: null,
      degraded: true,
      reason: 'No selectable model catalog entry was available; host defaults are unresolved.',
    };
  }
  if (entry.supportedReasoningEfforts.includes(requestedEffort)) {
    return { effort: requestedEffort, degraded: false, reason: null };
  }
  if (entry.supportedReasoningEfforts.includes(entry.defaultReasoningEffort)) {
    return {
      effort: entry.defaultReasoningEffort,
      degraded: true,
      reason: `Requested reasoning effort ${requestedEffort} is unsupported by ${entry.id}; using its advertised default.`,
    };
  }
  const requestedIndex = EFFORT_ORDER.indexOf(requestedEffort);
  const ranked = entry.supportedReasoningEfforts
    .map((effort) => ({ effort, index: EFFORT_ORDER.indexOf(effort) }))
    .sort((left, right) => {
      const leftAbove = left.index > requestedIndex ? 1 : 0;
      const rightAbove = right.index > requestedIndex ? 1 : 0;
      if (leftAbove !== rightAbove) return leftAbove - rightAbove;
      return Math.abs(requestedIndex - left.index) - Math.abs(requestedIndex - right.index);
    });
  return {
    effort: ranked[0].effort,
    degraded: true,
    reason: `Requested reasoning effort ${requestedEffort} is unsupported by ${entry.id}; using the nearest advertised effort.`,
  };
}

function requestedPolicy(stage, override) {
  const defaults = MODEL_POLICY_DEFAULTS[stage];
  if (!defaults && !override) {
    throw new TypeError(`unknown model-policy stage: ${stage}`);
  }
  return {
    tier: normalizeTier(override?.tier ?? defaults?.tier),
    reasoning_effort: normalizeEffort(
      override?.reasoning_effort ?? override?.reasoningEffort ?? defaults?.reasoning_effort,
    ),
  };
}

/**
 * Resolve a policy label against model/list without pretending an unavailable
 * tier or effort exists. A null resolved model means the caller must omit the
 * model selector and allow the host default.
 */
export function resolveModelPolicy({
  stage,
  catalog = [],
  requested = null,
  attemptNumber = 1,
  escalationReason = null,
  permissionBoundary = null,
} = {}) {
  if (typeof stage !== 'string' || !stage.trim()) throw new TypeError('stage is required');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new TypeError('attemptNumber must be a positive integer');
  }
  if (escalationReason != null && (typeof escalationReason !== 'string' || !escalationReason.trim())) {
    throw new TypeError('escalationReason must be null or a non-empty string');
  }
  const policy = requestedPolicy(stage, requested);
  const requestedModel = MODEL_IDS[policy.tier];
  const entries = visibleEntries(catalog);
  const exact = findRequested(entries, requestedModel);
  const selected = exact ?? chooseFallback(entries);
  const effort = resolveEffort(selected, policy.reasoning_effort);
  const modelDegraded = !exact;
  const degradationReasons = [];
  if (modelDegraded) {
    degradationReasons.push(
      selected
        ? `Requested model ${requestedModel} is unavailable; using advertised ${selected.id}.`
        : `Requested model ${requestedModel} is unavailable and no selectable catalog default was advertised.`,
    );
  }
  if (effort.reason) degradationReasons.push(effort.reason);

  return Object.freeze({
    schema_version: 1,
    stage: stage.trim(),
    requested: Object.freeze({
      tier: policy.tier,
      model_id: requestedModel,
      reasoning_effort: policy.reasoning_effort,
    }),
    resolved: Object.freeze({
      model_id: selected?.id ?? null,
      model: selected?.model ?? null,
      reasoning_effort: effort.effort,
      source: exact
        ? 'exact_catalog_match'
        : selected?.isDefault
          ? 'catalog_default'
          : selected
            ? 'catalog_fallback'
            : 'host_default_unresolved',
    }),
    degraded: modelDegraded || effort.degraded,
    degradation_reasons: Object.freeze(degradationReasons),
    attempt_number: attemptNumber,
    escalation_reason: escalationReason?.trim() ?? null,
    permission_boundary: permissionBoundary ?? null,
  });
}

const ESCALATION_LADDER = Object.freeze([
  Object.freeze({ tier: 'luna', reasoning_effort: 'medium' }),
  Object.freeze({ tier: 'terra', reasoning_effort: 'xhigh' }),
  Object.freeze({ tier: 'terra', reasoning_effort: 'ultra' }),
  Object.freeze({ tier: 'sol', reasoning_effort: 'xhigh' }),
  Object.freeze({ tier: 'astra', reasoning_effort: 'high' }),
  Object.freeze({ tier: 'sol', reasoning_effort: 'ultra' }),
  Object.freeze({ tier: 'astra', reasoning_effort: 'xhigh' }),
]);

function nextEscalationPair(tier, reasoningEffort) {
  const exactIndex = ESCALATION_LADDER.findIndex(
    (entry) => entry.tier === tier && entry.reasoning_effort === reasoningEffort,
  );
  if (exactIndex >= 0 && exactIndex < ESCALATION_LADDER.length - 1) {
    return ESCALATION_LADDER[exactIndex + 1];
  }
  if (exactIndex === ESCALATION_LADDER.length - 1) {
    return ESCALATION_LADDER[exactIndex];
  }

  const effortIndex = EFFORT_ORDER.indexOf(reasoningEffort);
  const nextKnownForTier = ESCALATION_LADDER.find(
    (entry) => entry.tier === tier
      && EFFORT_ORDER.indexOf(entry.reasoning_effort) > effortIndex,
  );
  if (nextKnownForTier) return nextKnownForTier;

  const firstTierIndex = ESCALATION_LADDER.findIndex((entry) => entry.tier === tier);
  if (firstTierIndex >= 0 && firstTierIndex < ESCALATION_LADDER.length - 1) {
    return ESCALATION_LADDER[firstTierIndex + 1];
  }
  return Object.freeze({ tier, reasoning_effort: reasoningEffort });
}

/**
 * Create the next evidenced soft-failure attempt.
 *
 * Cruise deliberately does not impose a universal attempt count here. The
 * owning workflow supplies its reviewed stop conditions and resource policy;
 * this resolver follows the reviewed model/effort ladder and records the new
 * attempt identity.
 */
export function escalateModelPolicy(
  previous,
  { catalog = [], reason, reasoningEffort = null, permissionBoundary = null } = {},
) {
  if (!previous || typeof previous !== 'object') {
    throw new TypeError('previous model-policy record is required');
  }
  if (!Number.isInteger(previous.attempt_number) || previous.attempt_number < 1) {
    throw new TypeError('previous model-policy attempt_number must be a positive integer');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError('an escalation reason is required');
  }
  const previousTier = normalizeTier(previous.requested?.tier);
  const priorEffort = normalizeEffort(previous.requested.reasoning_effort);
  const escalated = nextEscalationPair(previousTier, priorEffort);
  return resolveModelPolicy({
    stage: previous.stage,
    catalog,
    requested: {
      tier: escalated.tier,
      reasoning_effort: reasoningEffort ?? escalated.reasoning_effort,
    },
    attemptNumber: previous.attempt_number + 1,
    escalationReason: reason,
    permissionBoundary: permissionBoundary ?? previous.permission_boundary,
  });
}

export function modelRequestOptions(record) {
  if (!record?.resolved) throw new TypeError('a resolved model-policy record is required');
  return Object.freeze({
    ...(record.resolved.model ? { model: record.resolved.model } : {}),
    ...(record.resolved.reasoning_effort
      ? { reasoningEffort: record.resolved.reasoning_effort }
      : {}),
  });
}
