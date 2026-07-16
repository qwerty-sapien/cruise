import { spawnSync } from 'node:child_process';

const PLAN_PATH = '.cruise/goal/PLAN.md';
const GOAL_PATH = '.cruise/goal/GOAL.md';

function normalizedMarkdown(value) {
  const text = String(value ?? '').trim();
  return text ? `${text}\n` : '';
}

function headingTitle(markdown, fallback) {
  const match = String(markdown).match(/^#{1,6}\s+(.+?)\s*$/mu);
  return match?.[1]?.trim() || fallback;
}

function sectionBody(markdown, preferredHeadings) {
  const lines = String(markdown).replace(/\r\n/gu, '\n').split('\n');
  for (const preferred of preferredHeadings) {
    const headingIndex = lines.findIndex((line) => {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
      return match && match[2].trim().toLowerCase() === preferred.toLowerCase();
    });
    if (headingIndex < 0) continue;
    const body = [];
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^#{1,6}\s+/u.test(lines[index])) break;
      body.push(lines[index]);
    }
    const text = body.join('\n').trim();
    if (text) return { heading: preferred, text };
  }

  const firstHeading = lines.findIndex((line) => /^#{1,6}\s+/u.test(line));
  const body = lines
    .slice(firstHeading >= 0 ? firstHeading + 1 : 0)
    .filter((line) => !/^#{1,6}\s+/u.test(line))
    .join('\n')
    .trim();
  return { heading: 'Preview', text: body || '_No preview text was provided._' };
}

function boundedExcerpt(value, { maxLines, maxBytes }) {
  const selected = [];
  let bytes = 0;
  let truncated = false;
  for (const line of String(value).split('\n')) {
    if (selected.length >= maxLines) {
      truncated = true;
      break;
    }
    const addition = Buffer.byteLength(`${line}\n`, 'utf8');
    if (bytes + addition > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytes - Buffer.byteLength('…\n'));
      if (remaining > 0) {
        let prefix = '';
        for (const character of line) {
          if (Buffer.byteLength(prefix + character, 'utf8') > remaining) break;
          prefix += character;
        }
        if (prefix) selected.push(prefix);
      }
      truncated = true;
      break;
    }
    selected.push(line);
    bytes += addition;
  }
  const excerpt = selected.join('\n').trim();
  return truncated ? `${excerpt}\n\n…` : excerpt;
}

function markdownFileLink(label, absolutePath) {
  const target = String(absolutePath).replace(/>/gu, '%3E');
  return `[${label}](<${target}>)`;
}

function artifact(approval, path) {
  const found = approval?.artifacts?.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`Combined preview is missing ${path}.`);
  return found;
}

/** Build Cruise's deterministic combined preview from the exact captured bytes. */
export function buildCombinedPlanGoalPreview(
  approval,
  { maxLinesPerArtifact = 12, maxBytesPerArtifact = 1_200 } = {},
) {
  const goal = artifact(approval, GOAL_PATH);
  const plan = artifact(approval, PLAN_PATH);
  const goalMarkdown = goal.bytes.toString('utf8');
  const planMarkdown = plan.bytes.toString('utf8');
  const goalSection = sectionBody(goalMarkdown, ['Summary', 'Objective']);
  const planSection = sectionBody(planMarkdown, ['Summary', 'Steps']);
  const bounds = { maxLines: maxLinesPerArtifact, maxBytes: maxBytesPerArtifact };

  return normalizedMarkdown([
    '# Plan and Goal',
    '',
    `Bound revisions: Goal \`${goal.sha256}\` · Plan \`${plan.sha256}\``,
    '',
    `## Goal — ${headingTitle(goalMarkdown, 'Goal')}`,
    '',
    `### ${goalSection.heading}`,
    '',
    boundedExcerpt(goalSection.text, bounds),
    '',
    markdownFileLink('Open full Goal', goal.absolutePath),
    '',
    `## Plan — ${headingTitle(planMarkdown, 'Plan')}`,
    '',
    `### ${planSection.heading}`,
    '',
    boundedExcerpt(planSection.text, bounds),
    '',
    markdownFileLink('Open full Plan', plan.absolutePath),
  ].join('\n'));
}

/** Render Cruise-owned Markdown through Glow when available. */
export function renderPlanMarkdown(
  markdown,
  output,
  { spawn = spawnSync, width = 100 } = {},
) {
  const source = normalizedMarkdown(markdown);
  if (!source) return { renderer: 'none' };

  const rendered = spawn(
    'glow',
    ['--preserve-new-lines', '--width', String(width), '-'],
    {
      input: source,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (!rendered.error && rendered.status === 0 && rendered.stdout) {
    output.write(rendered.stdout);
    if (!rendered.stdout.endsWith('\n')) output.write('\n');
    return { renderer: 'glow', markdown: source };
  }

  output.write(source);
  return { renderer: 'markdown', markdown: source };
}

export function renderCombinedPlanGoalPreview(approval, output, options = {}) {
  const markdown = buildCombinedPlanGoalPreview(approval, options);
  return renderPlanMarkdown(markdown, output, options);
}
