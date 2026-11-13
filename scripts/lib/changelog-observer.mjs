import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  normalizeChangeSummaries,
  prepareCommitChangelogUpdate,
  writeCommitChangelog,
} from './user-reference.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 750;
const MAX_COMMITS_PER_OBSERVATION = 100;
const MAX_SUMMARY_OUTPUT_BYTES = 1_000_000;

async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function summaryEntries(value, allowedPaths, section) {
  const normalized = normalizeChangeSummaries(value);
  for (const path of normalized.keys()) {
    if (!allowedPaths.has(path)) {
      throw new Error(`${section} summary names a path outside the observed commit inventory`);
    }
  }
  if (normalized.size !== allowedPaths.size) {
    throw new Error(`${section} summary does not cover the complete observed commit inventory`);
  }
  return [...normalized].map(([path, summary]) => ({ path, summary }));
}

function extractJson(text) {
  const source = String(text ?? '').trim();
  if (!source) throw new Error('summary worker returned no output');
  if (Buffer.byteLength(source, 'utf8') > MAX_SUMMARY_OUTPUT_BYTES) {
    throw new Error('summary worker output exceeds the 1 MB safety bound');
  }
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    if (!fenced) throw new Error('summary worker output is not JSON');
    return JSON.parse(fenced[1]);
  }
}

export function parseChangelogSummaryOutput(output, update) {
  const parsed = extractJson(output);
  if (parsed?.version !== 1 || !Array.isArray(parsed.commit) || !Array.isArray(parsed.overall)) {
    throw new Error('summary worker output does not match the changelog schema');
  }
  return Object.freeze({
    commitSummaries: summaryEntries(
      parsed.commit,
      new Set(update.commitChanges.map(({ path }) => path)),
      'commit',
    ),
    overallSummaries: summaryEntries(
      parsed.overall,
      new Set(update.overallChanges.map(({ path }) => path)),
      'overall',
    ),
  });
}

export function changelogSummaryTask(update) {
  return [
    'Act as a read-only changelog summarizer running in parallel with the main Cruise session.',
    'Never read, search, or inspect root Markdown files whose basenames begin with an underscore.',
    'Use only the immutable, script-only Git evidence packet supplied below. Do not inspect a repository or working tree.',
    `Commit evidence: ${JSON.stringify(update.commitEvidence)}.`,
    `Overall since-last-push evidence: ${JSON.stringify(update.overallEvidence)}.`,
    'Return JSON only with this schema:',
    '{"version":1,"commit":[{"path":"relative/script.mjs","summary":"plain-language summary, at most 500 characters"}],"overall":[{"path":"relative/script.mjs","summary":"plain-language summary, at most 500 characters"}]}',
    'Return exactly one entry for every supplied path in its section, no other paths, no Markdown, no raw patch text, and no commentary.',
  ].join(' ');
}

async function commitsBetween(cwd, previous, current) {
  if (!previous || previous === current) return [];
  const ancestor = await git(cwd, ['merge-base', '--is-ancestor', previous, current], {
    allowFailure: true,
  });
  if (ancestor === null) return null;
  const commits = (await git(cwd, [
    'rev-list',
    '--reverse',
    `--max-count=${MAX_COMMITS_PER_OBSERVATION + 1}`,
    `${previous}..${current}`,
  ])).split(/\s+/u).filter(Boolean);
  return commits.length > MAX_COMMITS_PER_OBSERVATION ? [current] : commits;
}

async function rewrittenCommits(cwd, previous, current) {
  const reflogAction = await git(cwd, ['reflog', '-1', '--format=%gs', 'HEAD'], {
    allowFailure: true,
  });
  if (!/^(?:commit(?: \(amend\))?|rebase(?: \([^)]+\))?|merge|cherry-pick|revert):/iu.test(reflogAction ?? '')) {
    return null;
  }
  if (!/^rebase(?: \([^)]+\))?:/iu.test(reflogAction)) return [current];
  const mergeBase = await git(cwd, ['merge-base', previous, current], {
    allowFailure: true,
  });
  if (!mergeBase) return [current];
  const commits = (await git(cwd, [
    'rev-list',
    '--first-parent',
    '--reverse',
    `--max-count=${MAX_COMMITS_PER_OBSERVATION + 1}`,
    `${mergeBase}..${current}`,
  ])).split(/\s+/u).filter(Boolean);
  if (commits.length === 0 || commits.length > MAX_COMMITS_PER_OBSERVATION) return [current];
  return commits;
}

export class CommitChangelogObserver {
  constructor({
    cwd,
    inferSummaries,
    prepareUpdate = prepareCommitChangelogUpdate,
    writeUpdate = writeCommitChangelog,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => new Date().toISOString(),
    onWarning = () => {},
  }) {
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('observer cwd is required');
    if (typeof inferSummaries !== 'function') throw new TypeError('summary inference is required');
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 25) {
      throw new TypeError('poll interval must be an integer of at least 25ms');
    }
    this.cwd = cwd;
    this.inferSummaries = inferSummaries;
    this.prepareUpdate = prepareUpdate;
    this.writeUpdate = writeUpdate;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.onWarning = onWarning;
    this.activeRepository = false;
    this.observedHead = null;
    this.interval = null;
    this.polling = Promise.resolve();
    this.processing = Promise.resolve();
  }

  async start() {
    if (this.interval !== null) return;
    this.activeRepository = await git(this.cwd, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true,
    }) === 'true';
    if (!this.activeRepository) return;
    this.observedHead = await git(this.cwd, ['rev-parse', 'HEAD^{commit}'], {
      allowFailure: true,
    });
    this.interval = setInterval(() => {
      this.polling = this.polling
        .then(() => this.poll())
        .catch((error) => this.onWarning(error));
    }, this.pollIntervalMs);
    this.interval.unref?.();
  }

  async poll() {
    if (!this.activeRepository) return;
    const current = await git(this.cwd, ['rev-parse', 'HEAD^{commit}'], {
      allowFailure: true,
    });
    if (!current || current === this.observedHead) return;
    const previous = this.observedHead;
    this.observedHead = current;
    if (!previous) {
      this.scheduleCommits([current]);
      return;
    }
    const commits = await commitsBetween(this.cwd, previous, current);
    if (commits === null) {
      const rewritten = await rewrittenCommits(this.cwd, previous, current);
      if (rewritten === null) {
        this.onWarning(new Error('Git HEAD moved non-fast-forward without a commit-producing reflog action; no changelog commit segment was inferred'));
        return;
      }
      this.scheduleCommits(rewritten);
      return;
    }
    this.scheduleCommits(commits);
  }

  scheduleCommits(commits) {
    for (const commit of commits) {
      this.processing = this.processing
        .then(() => this.processCommit(commit))
        .catch((error) => this.onWarning(error));
    }
  }

  async processCommit(commit) {
    const update = await this.prepareUpdate({ cwd: this.cwd, commit });
    let inferred = { commitSummaries: [], overallSummaries: [] };
    if (update.commitChanges.length || update.overallChanges.length) {
      try {
        const output = await this.inferSummaries({
          update,
          task: changelogSummaryTask(update),
        });
        inferred = parseChangelogSummaryOutput(output, update);
      } catch (error) {
        this.onWarning(new Error(`parallel changelog inference failed: ${error.message}`));
      }
    }
    await this.writeUpdate({
      update,
      generatedAt: this.now(),
      ...inferred,
    });
  }

  async stop() {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.polling;
    await this.poll();
    await this.processing;
  }
}
