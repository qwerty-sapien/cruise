import { readFileSync } from 'node:fs';

export const INDEPENDENT_RELEASE_INSTRUCTIONS = readFileSync(
  new URL('../../skills/context-economy/references/INDEPENDENT_RELEASE.md', import.meta.url),
  'utf8',
).trim();
