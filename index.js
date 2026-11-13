#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from './scripts/cruise.mjs';

export * from './scripts/cruise.mjs';
export * from './scripts/lib/claude-cli.mjs';
export * from './scripts/lib/provider.mjs';
export * from './scripts/lib/migration-config.mjs';
export * from './scripts/lib/migration-controller.mjs';
export * from './scripts/lib/migration-policy.mjs';

const ENTRY_PATH = fileURLToPath(import.meta.url);

async function invokedAsMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const [entry, module] = await Promise.all([
    realpath(invoked).catch(() => resolve(invoked)),
    realpath(ENTRY_PATH).catch(() => ENTRY_PATH),
  ]);
  return entry === module;
}

if (await invokedAsMain()) process.exitCode = await main();
