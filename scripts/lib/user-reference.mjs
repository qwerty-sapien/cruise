import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { inspectFlightPlan } from './flight-plan.mjs';
import { assertNoSensitiveAccessRequest } from './sensitive-path.mjs';

const execFileAsync = promisify(execFile);

export const USER_REFERENCE_FILE = '_FOR_USER_REFERENCE.md';
export const USER_CHANGELOG_FILE = '_CHANGELOG.md';
export const USER_ONLY_MARKDOWN_PATHSPEC = ':(exclude,top,icase,glob)_*.md';

const USER_REFERENCE_HEADER = `# Cruise Goal reference

> User-only document. Cruise writes this file algorithmically and must never
> read, summarize, fingerprint, or use its contents as agent context.
`;

const USER_CHANGELOG_NOTICE = `# Cruise workspace changelog

> User-only document. Cruise updates this script-only summary through
> deterministic commit-triggered code. Agents must never read it or use its
> contents as context.
`;

export const MAX_CHANGE_SUMMARY_LENGTH = 500;
export const CHANGELOG_MAX_BYTES = 16 * 1024 * 1024;
const MAX_INFERENCE_EVIDENCE_PER_FILE = 8_000;
const MAX_INFERENCE_EVIDENCE_TOTAL = 96_000;
const OVERALL_START = '<!-- CRUISE:SINCE-LAST-PUSH:START -->';
const OVERALL_END = '<!-- CRUISE:SINCE-LAST-PUSH:END -->';
const HISTORY_START = '<!-- CRUISE:COMMIT-HISTORY:START -->';
const HISTORY_END = '<!-- CRUISE:COMMIT-HISTORY:END -->';
const RECOVERY_START = '<!-- CRUISE:GENERATED:V2:START -->';
const RECOVERY_END = '<!-- CRUISE:GENERATED:V2:END -->';
const SCRIPT_PATH = /\.(?:[cm]?[jt]sx?|pyi?|sh|bash|zsh|fish|rb|php|p[lm]|lua|r|go|rs|c|h|cc|cpp|cxx|hh|hpp|hxx|java|kt|kts|swift|scala|cs|fs|fsx|clj|cljs|cljc|ex|exs|erl|hrl|hs|lhs|sql|ps1|bat|cmd|vue|svelte)$/iu;
const USER_STATUSES = new Set([
  'completed',
  'blocked',
  'aborted',
  'unfinished',
  'not_started',
]);

function cleanLine(value, fallback = 'unavailable') {
  const line = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return line || fallback;
}

function markdownFence(value, language = 'text') {
  const text = String(value ?? '');
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function list(values) {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : '- None';
}

function gateSummary(gates) {
  if (!gates?.length) return '- None';
  return gates.map((gate) => [
    `- **${cleanLine(gate.id)}** — ${cleanLine(gate.state)}`,
    `  - Dimension: ${cleanLine(gate.dimension)}`,
    `  - Criterion: ${cleanLine(gate.criterion)}`,
    `  - Evidence: ${cleanLine(gate.evidence?.summary, 'None')}`,
  ].join('\n')).join('\n');
}

export function userGoalStatus(status, { started = true } = {}) {
  if (!started) return 'not_started';
  if (status === 'complete' || status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  if (status === 'interrupted' || status === 'aborted') return 'aborted';
  return 'unfinished';
}

function assertUserStatus(status) {
  if (!USER_STATUSES.has(status)) {
    throw new TypeError(`unsupported user Goal status: ${String(status)}`);
  }
  return status;
}

function referenceEntry({
  status,
  provider,
  prompt,
  startedAt,
  endedAt,
  sessionId,
  tracePointer,
  plan,
  reason,
}) {
  const normalizedStatus = assertUserStatus(status);
  if (['aborted', 'not_started'].includes(normalizedStatus)) {
    return [
      `## ${cleanLine(endedAt)} — ${normalizedStatus}`,
      '',
      `- **Status:** ${normalizedStatus}`,
      `- **Ended:** ${cleanLine(endedAt)}`,
      `- **Trace:** ${cleanLine(tracePointer)}`,
      '',
    ].join('\n');
  }
  const outcome = cleanLine(plan?.outcome, cleanLine(prompt, 'Goal details unavailable'));
  const sections = [
    `## ${cleanLine(endedAt)} — ${normalizedStatus}: ${outcome}`,
    '',
    `- **Status:** ${normalizedStatus}`,
    `- **Provider:** ${cleanLine(provider)}`,
    `- **Started:** ${cleanLine(startedAt, 'Not started')}`,
    `- **Ended:** ${cleanLine(endedAt)}`,
    `- **Session:** ${cleanLine(sessionId)}`,
    `- **Trace:** ${cleanLine(tracePointer)}`,
    `- **Reason:** ${cleanLine(reason, 'None')}`,
    '',
    '### Original request',
    '',
    markdownFence(prompt, 'text'),
  ];
  if (plan) {
    sections.push(
      '',
      '### Goal',
      '',
      `**Outcome:** ${cleanLine(plan.outcome)}`,
      '',
      '**Verification**',
      '',
      list(plan.verify ?? []),
      '',
      '**Touchpoints**',
      '',
      list(plan.scope?.touchpoints ?? []),
      '',
      '**Non-goals**',
      '',
      list(plan.scope?.nonGoals ?? []),
      '',
      '**Invariants**',
      '',
      list(plan.invariants ?? []),
      '',
      '**Quality gates**',
      '',
      gateSummary(plan.quality?.gates),
      '',
      '### Goal detail',
      '',
      plan.body?.trim() || '_No Goal body was recorded._',
    );
  } else {
    sections.push('', '### Goal', '', '_No current Flight was available for this run._');
  }
  return `${sections.join('\n')}\n\n`;
}

async function appendWithoutReading(path, text) {
  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${path} must be a regular file`);
    await handle.writeFile(`${created ? `${USER_REFERENCE_HEADER}\n` : ''}${text}`);
  } finally {
    await handle.close();
  }
}

function sameFileState(left, right) {
  return left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== 'function' ||
    typeof metadata?.uid !== 'number' ||
    metadata.uid === process.getuid();
}

async function safeReplaceWithoutReading(path, text, { expected = undefined } = {}) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
      throw new Error(`${path} must be a regular file`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = join(
    resolve(path, '..'),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expected !== undefined) {
      let current = null;
      try {
        current = await lstat(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (
        (expected === null && current !== null) ||
        (expected !== null && !sameFileState(expected, current))
      ) {
        throw new Error(`${path} changed while Cruise prepared its targeted update`);
      }
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: Infinity,
    });
    return stdout.trimEnd();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

async function resolveGitContext(cwd) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!root) return null;
  const branch = await git(root, ['branch', '--show-current'], { allowFailure: true });
  let upstream = await git(
    root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { allowFailure: true },
  );
  let baselineSource = 'configured upstream';
  if (!upstream && branch) {
    const fallback = `refs/remotes/origin/${branch}`;
    const exists = await git(root, ['show-ref', '--verify', '--hash', fallback], { allowFailure: true });
    if (exists) {
      upstream = `origin/${branch}`;
      baselineSource = 'origin tracking-ref fallback';
    }
  }
  const head = await git(root, ['rev-parse', 'HEAD^{commit}'], { allowFailure: true });
  const baseline = upstream
    ? await git(root, ['rev-parse', `${upstream}^{commit}`], { allowFailure: true })
    : null;
  return {
    root,
    branch: branch || '(detached)',
    upstream,
    baseline,
    baselineSource: baseline ? baselineSource : 'unavailable',
    head,
  };
}

function scriptPath(path) {
  return typeof path === 'string' &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    !/[\u0000-\u001f\u007f<>]/u.test(path) &&
    SCRIPT_PATH.test(path) && permittedEvidencePath(path);
}

function permittedEvidencePath(path) {
  try {
    assertNoSensitiveAccessRequest(`Read ${JSON.stringify(path)}`, 'Git evidence path');
    return true;
  } catch (error) {
    if (error?.code !== 'CRUISE_SENSITIVE_PATH') throw error;
    return false;
  }
}

function cleanSummary(value) {
  const summary = cleanLine(value, '');
  if (!summary) throw new TypeError('change summary must not be empty');
  if (/<!--|-->/u.test(summary)) {
    throw new TypeError('change summary must not contain generated-region markers');
  }
  return summary.length <= MAX_CHANGE_SUMMARY_LENGTH
    ? summary
    : `${summary.slice(0, MAX_CHANGE_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

export function normalizeChangeSummaries(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([path, summary]) => ({ path, summary }))
      : [];
  const summaries = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !scriptPath(entry.path)) {
      throw new TypeError('change summaries must name relative script paths');
    }
    summaries.set(entry.path, cleanSummary(entry.summary));
  }
  return summaries;
}

function parseNameStatus(output) {
  const fields = output.split('\u0000').filter(Boolean);
  const changes = new Map();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const kind = status[0];
    const oldPath = ['R', 'C'].includes(kind) ? fields[index++] : null;
    const path = fields[index++];
    if (!path) break;
    if (oldPath && scriptPath(oldPath) && !scriptPath(path)) {
      changes.set(oldPath, 'delete');
      continue;
    }
    if (oldPath && !scriptPath(oldPath) && scriptPath(path)) {
      changes.set(path, 'new');
      continue;
    }
    if (!scriptPath(path)) continue;
    changes.set(path, kind === 'A' || kind === 'C' ? 'new' : kind === 'D' ? 'delete' : 'patch');
  }
  return changes;
}

function changedNames(text) {
  const names = [];
  const patterns = [
    /\b(?:class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gu,
    /\b(?:test|it|describe)\s*\(\s*['"`]([^'"`]{1,100})/gu,
    /^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = cleanLine(match[1], '');
      if (name && !names.includes(name)) names.push(name);
      if (names.length >= 8) return names;
    }
  }
  return names;
}

async function fallbackChangeSummary(root, base, head, path, action) {
  if (!scriptPath(path)) throw new Error('Git evidence requires a permitted script path');
  let evidence = '';
  if (action === 'new') {
    evidence = await git(root, ['show', `${head}:${path}`], { allowFailure: true }) ?? '';
  } else {
    evidence = await git(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--unified=0',
      base,
      head,
      '--',
      `:(literal)${path}`,
    ], { allowFailure: true }) ?? '';
  }
  const names = changedNames(evidence);
  if (action === 'delete') {
    return cleanSummary(names.length
      ? `Removes the script and its ${names.join(', ')} behavior.`
      : 'Removes the script from the workspace.');
  }
  if (action === 'new') {
    return cleanSummary(names.length
      ? `Adds a new script implementing ${names.join(', ')}.`
      : 'Adds a new executable or source script.');
  }
  return cleanSummary(names.length
    ? `Updates ${names.join(', ')}.`
    : 'Updates the script behavior or integration.');
}

async function scriptChangeInventory(root, base, head) {
  const tracked = parseNameStatus(await git(root, [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--name-status',
    '-z',
    base,
    head,
    '--',
    '.',
    USER_ONLY_MARKDOWN_PATHSPEC,
    ':(exclude,top,glob).cruise/**',
  ]));
  return [...tracked.entries()]
    .map(([path, action]) => ({ path, action }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function rootCommitInventory(root, commit) {
  const output = await git(root, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--no-renames',
    '--name-status',
    '-r',
    '-z',
    commit,
    '--',
    '.',
    USER_ONLY_MARKDOWN_PATHSPEC,
    ':(exclude,top,glob).cruise/**',
  ]);
  return [...parseNameStatus(output).entries()]
    .map(([path, action]) => ({ path, action }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function inferenceEvidence(root, base, head, inventory) {
  const evidence = [];
  let remaining = MAX_INFERENCE_EVIDENCE_TOTAL;
  for (const { path, action } of inventory) {
    if (!scriptPath(path)) continue;
    if (remaining <= 0) {
      evidence.push({ path, action, patch: '[evidence bound reached]' });
      continue;
    }
    const output = base
      ? await git(root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--unified=3',
          base,
          head,
          '--',
          `:(literal)${path}`,
        ], { allowFailure: true })
      : await git(root, [
          'show',
          '--format=',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--unified=3',
          head,
          '--',
          `:(literal)${path}`,
        ], { allowFailure: true });
    const patch = String(output ?? '').slice(
      0,
      Math.min(MAX_INFERENCE_EVIDENCE_PER_FILE, remaining),
    );
    remaining -= patch.length;
    evidence.push({ path, action, patch });
  }
  return evidence;
}

function commitMarker(commit) {
  return `<!-- CRUISE:COMMIT:${commit} -->`;
}

function safeGeneratedLabel(value, fallback) {
  return cleanLine(value, fallback)
    .replace(/<!--/gu, '‹!--')
    .replace(/-->/gu, '--›');
}

function uniqueMarker(text, marker) {
  const first = text.indexOf(marker);
  return first >= 0 && first === text.lastIndexOf(marker) ? first : -1;
}

function generatedRegion(text) {
  const overallStart = uniqueMarker(text, OVERALL_START);
  const overallEnd = uniqueMarker(text, OVERALL_END);
  const historyStart = uniqueMarker(text, HISTORY_START);
  const historyEnd = uniqueMarker(text, HISTORY_END);
  return overallStart >= 0 && overallEnd > overallStart &&
    historyStart > overallEnd && historyEnd > historyStart
    ? { overallStart, overallEnd, historyEnd } : null;
}

function patchGeneratedChangelog(existing, overall, segment, commit) {
  const block = `${OVERALL_START}\n${overall}\n${OVERALL_END}\n\n## Commit history\n\n${HISTORY_START}\n${segment}${HISTORY_END}\n`;
  if (existing === null) return { text: Buffer.from(`${USER_CHANGELOG_NOTICE}\n${block}`), recovery: null };

  // Latin-1 gives byte offsets for ASCII markers without decoding user prose.
  // Buffer slices preserve even invalid UTF-8 and mixed newline conventions.
  const source = existing.toString('latin1');
  let start = 0;
  let end = existing.length;
  const recoveryStart = source.lastIndexOf(RECOVERY_START);
  if (recoveryStart >= 0) {
    start = recoveryStart + RECOVERY_START.length;
    end = source.indexOf(RECOVERY_END, start);
  }
  const region = end >= start ? generatedRegion(source.slice(start, end)) : null;
  if (!region) {
    return {
      text: Buffer.concat([existing, Buffer.from(`\n\n${RECOVERY_START}\n${block}${RECOVERY_END}\n`)]),
      recovery: Object.freeze({ version: 2, action: 'appended', preservedBytes: existing.length }),
    };
  }
  const { overallStart, overallEnd, historyEnd } = region;
  // Deduplicate only within the active block, never against preserved legacy data.
  const addition = source.slice(start, end).includes(commitMarker(commit)) ? '' : segment;
  return {
    text: Buffer.concat([
      existing.subarray(0, start + overallStart + OVERALL_START.length),
      Buffer.from(`\n${overall}\n`),
      existing.subarray(start + overallEnd, start + historyEnd),
      Buffer.from(addition),
      existing.subarray(start + historyEnd),
    ]),
    recovery: null,
  };
}

async function readGeneratedChangelog(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
      throw new Error(`${path} must be a regular file`);
    }
    if (metadata.size > CHANGELOG_MAX_BYTES) {
      throw new Error(`${path} exceeds the ${CHANGELOG_MAX_BYTES}-byte safety bound`);
    }
    const text = await readFile(path);
    const after = await lstat(path);
    if (!sameFileState(metadata, after)) {
      throw new Error(`${path} changed while Cruise inspected its generated markers`);
    }
    return { text, metadata: after };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: null, metadata: null };
    throw error;
  }
}

async function changeLines(update, inventory, summaries, base, head) {
  const supplied = normalizeChangeSummaries(summaries);
  return Promise.all(inventory.map(async ({ path, action }) => {
    const summary = supplied.get(path) ??
      await fallbackChangeSummary(update.root, base ?? head, head, path, action);
    return `- ${path}: ${action} - ${summary}`;
  }));
}

export async function prepareCommitChangelogUpdate({
  cwd,
  commit,
}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required');
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(commit)) {
    throw new TypeError('commit must be a Git object id');
  }
  const context = await resolveGitContext(cwd);
  if (!context) throw new Error('commit changelog requires a Git repository');
  const resolvedCommit = await git(context.root, ['rev-parse', `${commit}^{commit}`]);
  const parent = await git(context.root, ['rev-parse', `${resolvedCommit}^1`], { allowFailure: true });
  const metadata = (await git(context.root, [
    'show',
    '-s',
    '--format=%H%x00%h%x00%cI%x00%s',
    resolvedCommit,
  ])).split('\u0000');
  const commitChanges = parent
    ? await scriptChangeInventory(context.root, parent, resolvedCommit)
    : await rootCommitInventory(context.root, resolvedCommit);
  const overallChanges = context.baseline
    ? await scriptChangeInventory(context.root, context.baseline, resolvedCommit)
    : [];
  const [commitEvidence, overallEvidence] = await Promise.all([
    inferenceEvidence(context.root, parent, resolvedCommit, commitChanges),
    context.baseline
      ? inferenceEvidence(context.root, context.baseline, resolvedCommit, overallChanges)
      : [],
  ]);
  return Object.freeze({
    root: context.root,
    commit: resolvedCommit,
    shortCommit: metadata[1] || resolvedCommit.slice(0, 12),
    committedAt: metadata[2] || 'unavailable',
    subject: safeGeneratedLabel(metadata[3], 'Untitled commit'),
    parent,
    upstream: context.upstream,
    baseline: context.baseline,
    commitChanges,
    overallChanges,
    commitEvidence,
    overallEvidence,
  });
}

export async function writeCommitChangelog({
  update,
  generatedAt = new Date().toISOString(),
  commitSummaries = [],
  overallSummaries = [],
  onRecovery = null,
}) {
  if (!update || typeof update !== 'object' || typeof update.root !== 'string') {
    throw new TypeError('prepared changelog update is required');
  }
  const commitLines = await changeLines(
    update,
    update.commitChanges,
    commitSummaries,
    update.parent,
    update.commit,
  );
  const overallLines = update.baseline
    ? await changeLines(
        update,
        update.overallChanges,
        overallSummaries,
        update.baseline,
        update.commit,
      )
    : [];
  const overall = [
    `Generated: ${cleanLine(generatedAt)}`,
    '',
    '## Since last push',
    '',
    ...(update.baseline
      ? [overallLines.join('\n') || '- No committed script changes since the pushed baseline.']
      : ['- A pushed baseline is unavailable; per-commit history remains available below.']),
  ].join('\n');
  const segment = [
    commitMarker(update.commit),
    `### ${cleanLine(update.shortCommit)} — ${cleanLine(update.subject)}`,
    '',
    `Committed: ${cleanLine(update.committedAt)}`,
    '',
    commitLines.join('\n') || '- No script changes in this commit.',
    '',
  ].join('\n');
  const path = join(update.root, USER_CHANGELOG_FILE);
  const existing = await readGeneratedChangelog(path);
  const { text, recovery } = patchGeneratedChangelog(existing.text, overall, segment, update.commit);
  if (text.length > CHANGELOG_MAX_BYTES) {
    throw new Error(`${path} exceeds the ${CHANGELOG_MAX_BYTES}-byte safety bound`);
  }
  await safeReplaceWithoutReading(path, text, { expected: existing.metadata });
  if (recovery) onRecovery?.(recovery);
  return path;
}

export async function writeUserChangelog({
  cwd,
  commit,
  generatedAt = new Date().toISOString(),
  commitSummaries = [],
  overallSummaries = [],
}) {
  const update = await prepareCommitChangelogUpdate({ cwd, commit });
  return writeCommitChangelog({
    update,
    generatedAt,
    commitSummaries,
    overallSummaries,
  });
}

export async function writeGoalUserDocuments({
  cwd,
  prompt,
  provider,
  status,
  started = true,
  startedAt = null,
  endedAt = new Date().toISOString(),
  sessionId = null,
  tracePointer = null,
  reason = null,
  includeFlight = true,
}, {
  inspectPlan = inspectFlightPlan,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd is required');
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true }) ?? resolve(cwd);
  const userStatus = userGoalStatus(status, { started });
  let plan = null;
  if (includeFlight && !['aborted', 'not_started'].includes(userStatus)) {
    const inspection = await inspectPlan(cwd);
    if (inspection?.state === 'valid') plan = inspection.plan;
  }
  await appendWithoutReading(
    join(root, USER_REFERENCE_FILE),
    referenceEntry({
      status: userStatus,
      provider,
      prompt,
      startedAt,
      endedAt,
      sessionId,
      tracePointer,
      plan,
      reason,
    }),
  );
  return Object.freeze({
    status: userStatus,
    referencePath: join(root, USER_REFERENCE_FILE),
    changelogPath: join(root, USER_CHANGELOG_FILE),
  });
}
