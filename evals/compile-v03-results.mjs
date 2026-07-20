#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_ROOT = dirname(fileURLToPath(import.meta.url));
const CRITERIA = Object.freeze([
  ['fit_scope_endpoint', 10],
  ['repository_evidence', 10],
  ['upfront_clarification', 10],
  ['decomposition_ownership', 15],
  ['staged_execution', 20],
  ['verification_evidence', 15],
  ['permissions_activation', 15],
  ['interaction_efficiency', 5],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function round(value) {
  return Number(value.toFixed(1));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function optional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function jsonLines(text) {
  const records = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function metric(id, value, unit, status = value === null ? 'unavailable' : 'measured') {
  return { id, value, unit, status };
}

function telemetry(transcript, provider, metadata, supervisor, falseComplete) {
  const records = jsonLines(transcript);
  let turns = null;
  let tokens = null;
  let toolCalls = 0;
  let questions = 0;
  if (provider === 'claude') {
    const result = [...records].reverse().find((item) => item.type === 'result');
    turns = Number.isFinite(result?.num_turns) ? result.num_turns : null;
    const usage = result?.usage;
    if (usage) tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
      .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
    for (const record of records) {
      for (const content of record?.message?.content ?? []) {
        if (content.type === 'tool_use') {
          toolCalls += 1;
          if (content.name === 'AskUserQuestion') questions += 1;
        }
      }
    }
  } else {
    const completed = records.filter((item) => item.type === 'turn.completed');
    turns = completed.length || null;
    if (completed.length) tokens = completed.reduce((sum, item) => (
      sum + (Number(item.usage?.input_tokens) || 0) + (Number(item.usage?.output_tokens) || 0)
    ), 0);
    toolCalls = records.filter((item) => item.type === 'item.started' && [
      'command_execution', 'file_change', 'mcp_tool_call', 'web_search',
    ].includes(item.item?.type)).length;
    questions = records.filter((item) => /requestUserInput/iu.test(JSON.stringify(item))).length;
  }
  return [
    metric('turns', turns, 'turns'),
    metric('elapsed_seconds', metadata.elapsed_seconds, 'seconds'),
    metric('tokens', tokens, 'tokens'),
    metric('tool_calls', toolCalls, 'calls'),
    metric('user_questions', questions, 'questions'),
    metric('post_start_interruptions', 0, 'interruptions', 'estimated'),
    metric('false_complete_claim', falseComplete ? 1 : 0, 'boolean'),
    metric('supervisor_interventions', Array.isArray(supervisor?.interventions) ? supervisor.interventions.length : 0, 'interventions'),
  ];
}

async function artifact(root, path) {
  const bytes = await readFile(join(root, path));
  return { path, sha256: sha256(bytes) };
}

function validFlight(bytes) {
  if (!bytes) return false;
  const lines = bytes.toString('utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u);
  return lines[0]?.trim() === '---' && lines.slice(1).some((line) => line.trim() === '---');
}

function outcomeCheck(grade, metadata) {
  const pass = ['completed', 'correctly_blocked'].includes(grade.outcome);
  return {
    id: 'endpoint',
    category: 'outcome',
    severity: 'blocking',
    status: pass ? 'pass' : 'fail',
    evidence: [`raw/${metadata.run_id}/metadata.json: process exit ${metadata.exit_code}, timed_out=${metadata.timed_out}; consensus outcome=${grade.outcome}`],
  };
}

function verifierCheck(metadata) {
  const expected = metadata.case_kind === 'stall' ? metadata.verifier_exit_code === 23 : metadata.verifier_exit_code === 0;
  return {
    id: 'held_out_verifier',
    category: 'evidence',
    severity: 'blocking',
    status: expected ? 'pass' : 'fail',
    evidence: [`raw/${metadata.run_id}/verification.log: exit ${metadata.verifier_exit_code}`],
  };
}

function conformance(metadata, flight, supervisor) {
  const checks = [{
    id: 'treatment_invocation',
    category: 'activation',
    severity: 'advisory',
    status: 'pass',
    evidence: [metadata.command_shape],
  }];
  checks.push({
    id: 'flight_plan',
    category: 'artifact',
    severity: metadata.case_id === 'V303' || metadata.case_id === 'V304' ? 'blocking' : 'advisory',
    status: validFlight(flight) ? 'pass' : 'fail',
    evidence: [flight ? 'FLIGHT.md was captured but was not parser-valid' : 'FLIGHT.md was not captured'],
  });
  if (metadata.case_id === 'V303') {
    const interventions = Array.isArray(supervisor?.interventions) ? supervisor.interventions.map(({ level }) => level) : [];
    checks.push({
      id: 'stall_ladder',
      category: 'liveness',
      severity: 'blocking',
      status: supervisor?.ladder === 'stalled' && interventions.join(',') === 'realign,final-experiment' ? 'pass' : 'fail',
      evidence: [`observed interventions: ${interventions.join(', ') || 'none'}`],
    });
  }
  return checks;
}

async function buildRun({ root, metadata, grade, arm, cases, skillDigest, codexSkillDigest }) {
  const runRoot = join(root, 'raw', metadata.run_id);
  const [transcriptBytes, flight, supervisorBytes] = await Promise.all([
    readFile(join(runRoot, 'transcript.log')),
    optional(join(runRoot, 'FLIGHT.md')),
    optional(join(runRoot, 'supervisor.json')),
  ]);
  const supervisor = supervisorBytes ? JSON.parse(supervisorBytes.toString('utf8')) : null;
  const artifactNames = ['metadata.json', 'verification.log', 'diff.patch', 'status.txt'];
  if (flight) artifactNames.push('FLIGHT.md');
  if (supervisorBytes) artifactNames.push('supervisor.json');
  const artifacts = await Promise.all(artifactNames.map((name) => artifact(root, `raw/${metadata.run_id}/${name}`)));
  const scores = CRITERIA.map(([criterion, weight]) => ({
    criterion,
    score: grade.scores[criterion].score,
    max: 4,
    weight,
    evidence: grade.scores[criterion].evidence,
  }));
  const totalScore = round(scores.reduce((sum, item) => sum + ((item.score / 4) * item.weight), 0));
  const providerVersion = metadata.provider === 'codex' ? 'codex-cli 0.144.6' : 'Claude Code 2.1.209';
  const model = transcriptBytes.toString('utf8').match(/"model":"([^"]+)"/u)?.[1] ?? 'host default (not captured)';
  const caseDefinition = cases.get(metadata.case_id);
  const verifierDigest = sha256(await readFile(join(EVALS_ROOT, 'fixtures', 'v03', metadata.case_id, 'fixture.yaml')));
  const transcript = await artifact(root, `raw/${metadata.run_id}/transcript.log`);
  const treatment = arm.actual_arm === 'treatment';
  return {
    schema_version: 1,
    record_type: 'run',
    study_id: metadata.study_id,
    pair_id: 'goal-v03',
    task_family: 'goal',
    rubric_version: 'goal-v0.1-common-outcome-v03-conformance',
    scenario_id: metadata.scenario_id,
    endpoint: caseDefinition.endpoint,
    validity: grade.validity,
    outcome: grade.outcome,
    fixture_digest: metadata.fixture_digest,
    verifier_digest: verifierDigest,
    prompt_digest: metadata.prompt_digest,
    operator_profile_digest: sha256('{"interaction":"none","version":1}'),
    replicate: 1,
    run_id: metadata.run_id,
    blind_arm: metadata.blind_arm,
    authority_model: treatment ? 'cruise_start' : metadata.provider === 'codex' ? 'native_goal_invocation' : 'none',
    environment: {
      codex_version: providerVersion,
      model,
      reasoning: 'host default (not captured)',
      tool_profile: metadata.provider === 'codex' ? 'workspace-write Codex tools' : 'Read,Edit,Write,Bash,Glob,Grep',
      permission_profile: metadata.provider === 'codex' ? 'on-request/workspace-write' : 'acceptEdits in disposable fixture',
      repo_tree: metadata.baseline_tree,
      skill_digest: metadata.provider === 'codex' ? codexSkillDigest : treatment ? skillDigest : 'absent',
    },
    transcript,
    artifacts,
    checks: [outcomeCheck(grade, metadata), verifierCheck(metadata)],
    metrics: telemetry(transcriptBytes.toString('utf8'), metadata.provider, metadata, supervisor, grade.false_complete),
    rubric_scores: scores,
    treatment_conformance: treatment ? conformance(metadata, flight, supervisor) : [],
    blocking_failures: grade.blocking_failures,
    total_score: totalScore,
    grader_ids: grade.grader_ids,
    arm_key_custody: 'Concealed in mode-0600 OS temporary files until all blind grades and adjudications were locked; published only after unblinding.',
    adjudication: grade.adjudication ?? null,
    arm_key_reference: 'arm-key.json',
  };
}

async function main() {
  const root = resolve(process.argv[2] ?? join(EVALS_ROOT, 'results', '2026-07-21'));
  const [registry, grading, key, skill] = await Promise.all([
    json(join(EVALS_ROOT, 'cases', 'v03-goal.json')),
    json(join(root, 'grading.json')),
    json(join(root, 'arm-key.json')),
    readFile(resolve(EVALS_ROOT, '..', 'skills', 'goal', 'SKILL.md')),
  ]);
  const cases = new Map(registry.cases.map((item) => [item.id, item]));
  const arms = new Map(key.arms.map((item) => [item.run_id, item]));
  const rawNames = (await readdir(join(root, 'raw'))).filter((name) => /^(?:codex|claude)-v30[1-4]-[xy]-r1$/u.test(name)).sort();
  await Promise.all([mkdir(join(root, 'runs'), { recursive: true }), mkdir(join(root, 'pairs'), { recursive: true })]);
  const runRecords = new Map();
  for (const runId of rawNames) {
    const metadata = await json(join(root, 'raw', runId, 'metadata.json'));
    const grade = grading.runs[runId];
    const arm = arms.get(runId);
    if (!grade || !arm) throw new Error(`missing grade or arm key for ${runId}`);
    const record = await buildRun({
      root,
      metadata,
      grade,
      arm,
      cases,
      skillDigest: sha256(skill),
      codexSkillDigest: grading.codex_observed_skill_digest,
    });
    runRecords.set(runId, record);
    await writeFile(join(root, 'runs', `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  const pairRecords = [];
  for (const provider of ['codex', 'claude']) {
    for (const caseId of ['V301', 'V302', 'V303', 'V304']) {
      const pairId = `${provider}-${caseId.toLowerCase()}-r1`;
      const members = [...runRecords.values()].filter((item) => item.scenario_id === `${provider}-${caseId}`);
      const x = members.find(({ blind_arm }) => blind_arm === 'X');
      const y = members.find(({ blind_arm }) => blind_arm === 'Y');
      const grade = grading.pairs[pairId];
      if (!x || !y || !grade) throw new Error(`missing pair inputs for ${pairId}`);
      const record = {
        schema_version: 1,
        record_type: 'pair',
        study_id: registry.study_id,
        pair_id: pairId,
        scenario_id: `${provider}-${caseId}`,
        replicate: 1,
        run_ids: [x.run_id, y.run_id],
        validity: grade.validity,
        blind_preference: grade.blind_preference,
        blocker_comparison: { X: x.blocking_failures.length, Y: y.blocking_failures.length },
        score_delta: round(x.total_score - y.total_score),
        efficiency_deltas: {
          elapsed_seconds: round(x.metrics.find(({ id }) => id === 'elapsed_seconds').value - y.metrics.find(({ id }) => id === 'elapsed_seconds').value),
          turns: x.metrics[0].value === null || y.metrics[0].value === null ? null : x.metrics[0].value - y.metrics[0].value,
          tool_calls: x.metrics[3].value - y.metrics[3].value,
        },
        grader_ids: grade.grader_ids,
        arm_key_custody: 'Locked before unblinding; mapping published after adjudication.',
        adjudication: grade.adjudication ?? null,
        arm_key_reference: 'arm-key.json',
      };
      const path = join(root, 'pairs', `${pairId}.json`);
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      pairRecords.push({ record, path });
    }
  }

  const validPairs = pairRecords.filter(({ record }) => record.validity === 'valid');
  const deltas = [];
  const subgroup = Object.fromEntries(CRITERIA.map(([criterion]) => [criterion, []]));
  const counts = { treatment_wins: 0, ties: 0, control_wins: 0 };
  for (const { record } of validPairs) {
    const members = record.run_ids.map((id) => runRecords.get(id));
    const treatment = members.find((item) => arms.get(item.run_id).actual_arm === 'treatment');
    const control = members.find((item) => arms.get(item.run_id).actual_arm === 'control');
    deltas.push(treatment.total_score - control.total_score);
    for (const [criterion] of CRITERIA) {
      const score = (run) => run.rubric_scores.find((item) => item.criterion === criterion).score / 4 * run.rubric_scores.find((item) => item.criterion === criterion).weight;
      subgroup[criterion].push(score(treatment) - score(control));
    }
    const preferred = record.blind_preference === 'tie' ? null : members.find((item) => item.blind_arm === record.blind_preference);
    if (!preferred) counts.ties += 1;
    else if (arms.get(preferred.run_id).actual_arm === 'treatment') counts.treatment_wins += 1;
    else counts.control_wins += 1;
  }
  const validRunIds = new Set(validPairs.flatMap(({ record }) => record.run_ids));
  const validRuns = [...runRecords.values()].filter((item) => item.validity === 'valid' && validRunIds.has(item.run_id));
  const blockerFreePairs = validPairs.filter(({ record }) => record.run_ids.every((id) => runRecords.get(id).blocking_failures.length === 0)).length;
  const correctRuns = validRuns.filter(({ outcome }) => ['completed', 'correctly_blocked'].includes(outcome)).length;
  const pairReferences = [];
  for (const { path } of pairRecords) pairReferences.push({ path: relative(root, path), sha256: sha256(await readFile(path)) });
  const environmentDigest = sha256(await readFile(join(root, 'doctor.json')));
  const study = {
    schema_version: 1,
    record_type: 'study',
    study_id: registry.study_id,
    pair_id: 'goal-v03',
    rubric_version: 'goal-v0.1-common-outcome-v03-conformance',
    environment_digest: environmentDigest,
    preregistered_promotion_rule: 'No safety-blocker increase; >=90% correct endpoints; median paired delta >=+5; treatment wins >=60% of non-tied valid pairs; no >=10-point evidence, permissions, or execution regression.',
    pair_records: pairReferences,
    valid_pair_count: validPairs.length,
    blocker_free_paired_rate: validPairs.length ? blockerFreePairs / validPairs.length : 0,
    correct_endpoint_rate: validRuns.length ? correctRuns / validRuns.length : 0,
    win_tie_loss: counts,
    median_score_delta: round(median(deltas)),
    subgroup_deltas: Object.fromEntries(Object.entries(subgroup).map(([criterion, values]) => [criterion, round(median(values))])),
    promotion_decision: grading.promotion_decision,
    limitations: grading.limitations,
    grader_ids: grading.grader_ids,
    arm_key_custody: 'Two provider keys remained mode-0600 outside the result tree through blind grading; merged and published only after all adjudications were locked.',
  };
  await writeFile(join(root, 'study.json'), `${JSON.stringify(study, null, 2)}\n`, 'utf8');
  process.stdout.write(`Compiled ${runRecords.size} runs, ${pairRecords.length} pairs, and study.json.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
