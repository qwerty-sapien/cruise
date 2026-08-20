const NARROW_SKILL_TRIGGER_INSTRUCTIONS = [
  'Activate seeking-alpha only for an explicit novelty or research-edge search.',
  'Activate dag-prompts only for an explicit DAG or preregistration request, or at least three independently dispatchable units.',
  'Activate auto-experiment only for an actual experiment, model comparison, statistical claim, protected outcome, or holdout decision.',
  'Activate ship-kaggle-kernels only at a packaging, certification, launch, submission, or remote-monitoring boundary.',
  'Activate noconflict-env only from an exact failing dependency, interpreter, ABI, resolver, lockfile, or linker fact.',
  'For appi-enforcement, obey NONE, AFFECTED_SCOPE, or FULL; passing affected checks never trigger recursive Cruise debug.',
].join(' ');

export function skillTriggerInstructions() {
  return NARROW_SKILL_TRIGGER_INSTRUCTIONS;
}

export function shouldActivateSkill(name, {
  request = '',
  independentUnits = 0,
  boundary = null,
  exactDependencyOrInterpreter = false,
} = {}) {
  const text = String(request);
  switch (name) {
    case 'seeking-alpha':
      return /\b(?:novelty|research[- ]edge|non-obvious (?:edge|search)|seeking alpha|differentiate)\b/iu.test(text);
    case 'dag-prompts':
      return /\b(?:DAG|preregister|preregistration)\b/u.test(text) || independentUnits >= 3;
    case 'auto-experiment':
      return /\b(?:experiment|model comparison|statistical claim|protected outcome|holdout)\b/iu.test(text);
    case 'ship-kaggle-kernels':
      return ['packaging', 'certification', 'launch', 'submission', 'remote-monitoring'].includes(boundary) ||
        /\b(?:package|certify|launch|submit|remote monitoring)\b.{0,40}\bKaggle\b/iu.test(text);
    case 'noconflict-env':
      return exactDependencyOrInterpreter &&
        /\b(?:dependency|interpreter|ABI|resolver|lockfile|peer dependency|linker)\b/iu.test(text);
    default:
      return false;
  }
}

export function resolveAppiEnforcement({ requiredScan, affectedBehavior = 'unknown' } = {}) {
  if (!['NONE', 'AFFECTED_SCOPE', 'FULL'].includes(requiredScan)) {
    throw new TypeError('requiredScan must be NONE, AFFECTED_SCOPE, or FULL');
  }
  return Object.freeze({
    required_scan: requiredScan,
    recursive_debug: requiredScan !== 'NONE' &&
      (affectedBehavior === 'failing' || affectedBehavior === 'ambiguous'),
  });
}
