#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activateGoalSession } from './session-marker.mjs';

async function readInput(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error('hook input exceeds 1 MB');
  }
  return JSON.parse(text);
}

export function invokesCruiseGoal(input) {
  if (!input || !['UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse'].includes(input.hook_event_name)) {
    return false;
  }
  const prompt = [input.prompt, input.user_prompt, input.message]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const commandName = typeof input.command_name === 'string' ? input.command_name : '';
  const skillInput = input.hook_event_name === 'PreToolUse' &&
    /(?:^|:)Skill$/u.test(String(input.tool_name ?? ''))
    ? JSON.stringify(input.tool_input ?? {})
    : '';
  return /(?:^|\s)\$?cruise:goal\b|(?:^|\s)\/cruise:goal\b/iu.test(prompt) ||
    /^(?:\/)?cruise:goal$/iu.test(commandName) ||
    /(?:\/|\$)?cruise:goal\b/iu.test(skillInput);
}

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  try {
    const event = await readInput(input);
    if (invokesCruiseGoal(event)) await activateGoalSession(event);
  } catch (error) {
    if (error?.code === 'CRUISE_GOAL_CONFLICT') {
      output.write(JSON.stringify({ decision: 'block', reason: error.message }));
    } else {
      output.write(JSON.stringify({
        decision: 'block',
        reason: `Cruise Goal activation failed; assurance supervision is unavailable: ${String(error?.message ?? error).replace(/\s+/gu, ' ').trim()}`,
      }));
    }
  }
  return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
