#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['test'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
