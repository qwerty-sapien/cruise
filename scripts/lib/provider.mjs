export const DEFAULT_PROVIDER = 'codex';

export const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    commandPrefix: '$',
    skillNamespace: 'cruise',
    nativeGoalLifecycle: true,
  }),
  claude: Object.freeze({
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    commandPrefix: '/',
    skillNamespace: 'cruise',
    nativeGoalLifecycle: false,
  }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export function normalizeProvider(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!Object.hasOwn(PROVIDERS, normalized)) {
    throw new Error(`provider must be one of: ${PROVIDER_IDS.join(', ')}`);
  }
  return normalized;
}

export function resolveProvider(value = null, { env = process.env } = {}) {
  return normalizeProvider(value ?? env.CRUISE_PROVIDER ?? DEFAULT_PROVIDER);
}

export function providerDefinition(value = DEFAULT_PROVIDER) {
  return PROVIDERS[normalizeProvider(value)];
}

export function skillReference(provider, skill) {
  const definition = providerDefinition(provider);
  return `${definition.commandPrefix}${definition.skillNamespace}:${skill}`;
}
