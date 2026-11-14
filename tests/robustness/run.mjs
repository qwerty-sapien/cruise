#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateCases, NOT_EVALUATED } from './corpus.mjs';
import { summarize, validateCaseArtifact } from './oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const sourceFiles = ['package.json', 'scripts/lib/simple-session.mjs', 'scripts/lib/simple-worker.mjs',
  'scripts/lib/app-server-client.mjs', 'scripts/lib/line-input.mjs', 'scripts/lib/picker.mjs',
  'scripts/lib/supervisor.mjs', 'scripts/lib/assurance.mjs', 'scripts/lib/flight-plan.mjs',
  'scripts/lib/worker-policy.mjs', 'scripts/lib/model-policy.mjs', 'scripts/lib/trace-locator.mjs',
  'scripts/lib/origin-note.mjs', 'skills/goal/scripts/agent-context.mjs',
  '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'index.js'];
const harnessFiles = ['corpus.mjs', 'transforms.mjs', 'adapters.mjs', 'case-child.mjs', 'oracle.mjs', 'run.mjs', '../robustness.test.mjs'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function fingerprint(root, files) {
  const hashes = {};
  for (const path of files) {
    try { hashes[path] = sha(await readFile(join(root, path))); }
    catch (error) { hashes[path] = { unavailable: error.code }; }
  }
  return { sha256: sha(JSON.stringify(hashes)), files: hashes };
}
function revision(root) {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', timeout: 1000 });
  if (git.status !== 0 || resolve(git.stdout.trim()) !== resolve(root)) return null;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 1000 });
  return head.status === 0 ? head.stdout.trim() : null;
}
function dirtyState(root) {
  if (!revision(root)) return null;
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no', '--', ...sourceFiles],
    { cwd: root, encoding: 'utf8', timeout: 1000 });
  return status.status === 0 ? Boolean(status.stdout.trim()) : null;
}
function killOwnedGroup(pid) {
  if (!pid || process.platform === 'win32') return;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  try { process.kill(-pid, 0); throw new Error(`Task-owned process group ${pid} still exists`); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function runEvaluation({ target = repository, output, seed = 1729, discoverySeeds = 2, heldoutSeeds = 1, declaredRevision = null, cases = null } = {}) {
  if (!output) throw new TypeError('output directory is required');
  target = resolve(target); output = resolve(output);
  // Never write fixture data inside the target or include case results in its
  // fingerprint. All target interaction is read-only import/metadata access.
  await mkdir(output, { recursive: true });
  const selectedCases = cases ?? generateCases({ seed, discoverySeeds, heldoutSeeds });
  const source = { path: target, revision: revision(target), declaredRevision, trackedSourceDirty: dirtyState(target), ...(await fingerprint(target, sourceFiles)) };
  const harness = { revision: revision(repository), ...(await fingerprint(here, harnessFiles)) };
  const results = [];
  for (const testCase of selectedCases) {
    const temporary = await mkdtemp(join(tmpdir(), 'cruise-robustness-case-'));
    const root = join(temporary, 'fixture'); const artifact = join(temporary, 'result.json');
    await mkdir(root);
    const nonce = randomUUID(); let child; let result;
    try {
      child = spawnSync(process.execPath, ['--unhandled-rejections=strict', join(here, 'case-child.mjs'),
        JSON.stringify(testCase), target, root, artifact, nonce], {
        cwd: root, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', detached: process.platform !== 'win32',
        maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, NO_COLOR: '1' },
      });
      let artifactText;
      try { artifactText = await readFile(artifact, 'utf8'); } catch { artifactText = ''; }
      result = validateCaseArtifact({ child, text: artifactText, nonce, testCase });
    } catch (error) {
      result = { status: child?.error || child?.signal ? 'invariant_fail' : 'harness_error', assertions: 0,
        outcome: 'not_completed', observations: [{ message: error.message, stderr: child?.stderr ?? '', stdout: child?.stdout ?? '' }] };
    } finally {
      // All children are in a task-owned group, including bounded npm/mkfifo
      // grandchildren. Confirm no group survives, including on strict crashes.
      if (child?.pid) killOwnedGroup(child.pid);
      await rm(temporary, { recursive: true, force: true });
    }
    const row = { ...testCase, ...result, child: { pid: child?.pid ?? null, exitCode: child?.status ?? null, signal: child?.signal ?? null, joined: true } };
    delete row.nonce; results.push(row);
    if (row.status !== 'pass') {
      await mkdir(join(output, 'failures'), { recursive: true });
      // Single adapter+mutation is the replay unit. No failed transcript dump,
      // unrelated context, model output, or credentials is retained.
      await writeFile(join(output, 'failures', `${testCase.id}.json`), JSON.stringify({ schemaVersion: 1,
        case: testCase, source, harness, failure: row,
        replay: `node tests/robustness/run.mjs --target ${JSON.stringify(target)} --output REPLAY_DIR --replay ${JSON.stringify(join(output, 'failures', `${testCase.id}.json`))}` }, null, 2) + '\n');
    }
  }
  const after = await fingerprint(target, sourceFiles);
  if (after.sha256 !== source.sha256) throw new Error('Target source changed during evaluation; rerun against a frozen target');
  if ((await fingerprint(here, harnessFiles)).sha256 !== harness.sha256) throw new Error('Harness changed during evaluation; rerun against a frozen harness');
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 1000 });
  const report = { schemaVersion: 1, methodology: 'Deterministic bounded seeded structured mutation search; no gradients or real models.',
    splitPolicy: 'Discovery and held-out values perturb the same declared scenario families; these are not unseen failures or independent model generalization. Seeds are fixed before execution, without tuning from held-out results.',
    seed, discoverySeeds, heldoutSeeds, source, harness, nodeVersion: process.version,
    npmVersion: npm.status === 0 ? npm.stdout.trim() : null,
    oracleScope: 'Case artifacts prove evaluator predicates and observed production-function assertions. They do not validate real task artifact truth, model reasoning, or native authentication recovery.',
    summary: summarize(results), notEvaluated: NOT_EVALUATED, results };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  const columns = ['id', 'family', 'adapter', 'variant', 'split', 'seed', 'critical', 'status', 'outcome', 'assertions'];
  const tsv = (value) => String(value ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ');
  await writeFile(join(output, 'results.tsv'), [columns.join('\t'), ...results.map((row) => columns.map((column) => tsv(row[column])).join('\t'))].join('\n') + '\n');
  return report;
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--target': 'target', '--output': 'output', '--seed': 'seed', '--declared-revision': 'declaredRevision', '--discovery-seeds': 'discoverySeeds',
      '--heldout-seeds': 'heldoutSeeds', '--replay': 'replay' }[args[index]];
    if (!key || args[index + 1] === undefined) throw new Error('Usage: run.mjs --output DIR [--target PATH] [--seed UINT32] [--discovery-seeds 1..5] [--heldout-seeds 1..5] [--replay FILE]');
    options[key] = ['seed', 'discoverySeeds', 'heldoutSeeds'].includes(key) ? Number(args[index + 1]) : args[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.replay) {
      const replay = JSON.parse(await readFile(options.replay, 'utf8'));
      if (!replay.case?.adapter || !replay.case?.id) throw new Error('Replay has no case');
      options.cases = [replay.case];
    }
    const report = await runEvaluation(options);
    process.stdout.write(JSON.stringify({ output: resolve(options.output), ...report.summary }) + '\n');
    process.exitCode = report.summary.invariantFailures || report.summary.harnessErrors ? 1 : 0;
  } catch (error) { process.stderr.write(`Robustness harness: ${error.message}\n`); process.exitCode = 2; }
}
