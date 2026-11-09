import { readFileSync } from 'node:fs';

export const COLLABORATIVE_GIT_SYNC_INSTRUCTIONS = readFileSync(
  new URL('../../skills/context-economy/references/COLLABORATIVE_GIT_SYNC.md', import.meta.url),
  'utf8',
).trim();
