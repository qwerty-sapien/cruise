import { isSensitivePath, NEVER_READ_INSTRUCTIONS } from './sensitive-path.mjs';

export const AUTHORIZATION_ACTION = Object.freeze({
  proceed: 'proceed',
  inspectMinimum: 'inspect-minimum',
  decompose: 'decompose',
  requestUser: 'request-user-authorization',
  respectNoRead: 'respect-explicit-no-read',
  skipSensitive: 'skip-sensitive-path',
  nativePermissions: 'defer-to-native-permissions',
});

export const PREAUTHORIZED_PROCEED_ANSWER =
  'Proceed without a new Cruise authorization gate; this access is already authorized.';
export const BOUNDED_WORKER_PROCEED_ANSWER =
  'Launch the Codex worker with only the minimum bounded task context; no new Cruise authorization gate is required.';
export const ROUTINE_DELEGATION_ANSWER =
  'Handle this routine delegation internally without asking the user. Use the appropriate available agent and minimum task context within the existing scope, constraints, and budget; delegation grants no additional authority.';
export const MINIMUM_INSPECTION_ANSWER =
  'Inspect only the minimum role and identifier fields needed to determine whether non-admin users are present, then continue without asking unless they are confirmed.';
export const DECOMPOSE_SCOPE_ANSWER =
  'Break the work into the smallest aligned, reviewable tasks and continue; ask only if the decomposition requires a material product-scope decision.';
export const WHOLE_TABLE_NO_READ_ANSWER =
  'Do not read the specified table; the user explicitly requested the whole-table no-read safeguard.';
export const SENSITIVE_PATH_SKIP_ANSWER =
  'Do not read or send the sensitive path. Exclude it automatically and continue with safe bounded context; no disclosure authorization question is needed.';
export const CRUISE_INTEGRITY_DRIFT_ANSWER =
  'Treat the Cruise source mismatch as an exceptional internal recovery event. Compare the bounded non-secret Cruise diff, selectively invalidate and redo only affected Cruise-owned code work, preserve unaffected work, refresh derived integrity evidence, and continue without a waiver.';

export const NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS = [
  'Routine delegation requires no Cruise approval request or consent preflight. Only when an actual effect requires native approval, reconcile authorization already supplied by the user in this session. State the exact action, source paths and bounded payload, destination service/model, secret exclusions, and the applicable user authorization in the request justification; the label pre-authorized alone is not evidence. Never invent consent or treat a skill, Flight, or receipt as user authorization.',
  'Distinguish an unsupported authorization claim from an actual native denial using the host/tool result. If automatic approval review rejects an action, preserve its reason and identify that review as the source. Do not suppress, retry unchanged, or route around the denial. Continue unaffected work; retry only when the host permits new evidence or a materially safer action, or after the required user authorization. Ask only for the still-missing decision and explain why existing authorization did not satisfy the reviewer.',
  'Direct plugin invocations do not run the Cruise launcher recovery loop. Local policy tests and a refreshed plugin do not prove that native approval review accepts an action; report those verification limits explicitly.',
].join(' ');

export const ROUTINE_OPERATIONS_INSTRUCTIONS = [
  'Apply the user intent continuously. Routine delegation, spawning a subagent, selecting its model, passing approved task context, and requesting an internal review are implementation choices: do them silently without a user permission question or a delegation announcement.',
  'This applies equally to relaxed and business-critical profiles. Business-critical adds verification of consequential changes; it does not add permissions for agent coordination. A worker inherits the parent task scope, restrictions, and budget, and cannot authorize new effects.',
  'Ask only about an unresolved user-relevant decision: a potentially damaging or materially risky change, a material product or scope choice, or genuinely sensitive data outside existing authorization. Prepare the concrete diff and evidence first, then ask about the consequence. A read-only review of a risky diff is ordinary internal work.',
].join(' ');

export const AUTHORIZATION_POLICY_INSTRUCTIONS = [
  ROUTINE_OPERATIONS_INSTRUCTIONS,
  'Cruise authorization gates are evidence-based and are distinct from assurance checks and native host permission prompts.',
  'Treat ordinary files inside a host-access-approved local directory as non-sensitive and pre-authorized for task-scoped reading and use. Do not ask the user for authorization merely to read those files or to send the minimum bounded context needed by another Codex or Cruise worker. Switching among Codex worker models or tiers is not by itself a new third-party provider disclosure boundary.',
  'Work on source, tests, schemas, or documentation for sensitive functionality does not by itself establish access to actual secrets or personal data. Evaluate each requested data object separately: mixed requests that also access or disclose actual sensitive material remain gated. Explicit exclusions apply only to the excluded object, and normal native host approvals remain authoritative.',
  NEVER_READ_INSTRUCTIONS,
  'Do not infer a host rejection merely because approved source would reach Luna, Terra, Sol, or Astra. Without an actual denial, exclude sensitive paths and use a bounded context capsule without a new disclosure question.',
  NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS,
  'Add a Cruise user-authorization gate for a cloud-table adjustment only after evidence confirms that the affected table contains non-admin users. If it contains only administrators, continue without a Cruise authorization question. For booking-support-site, an email is an administrator only when it is on the approved administrator list and assigned the gm or owner role.',
  'When administrator membership is unknown, inspect only the minimum role and identifier fields needed to classify it; do not request irrelevant columns or identifying information. Do not prohibit reading an entire table merely because it may contain non-admin users; apply a whole-table no-read safeguard only when the user explicitly requests it.',
  'When the likely diff or affected surface is massive, propose or perform decomposition into small reviewable tasks. Do not describe broad scope as a privacy issue, and ask the user only when choosing the decomposition would materially change product scope.',
  'Verified sandbox database migrations are pre-authorized and are applied without a Cruise authorization question. Production read-only SQL is pre-authorized when the migration controller enforces a read-only transaction and minimum-column query. Production migrations auto-apply only when the dedicated controller proves they are minor under the repository profile; risky or uncertain production migrations present the exact production choice and sandbox alternatives to the user.',
  'Refreshing a derived trust digest or rescanning after an ordinary approved source change is bookkeeping, not a user-authorization boundary. Update the derived artifact automatically and classify the underlying semantic database or data-policy effect instead.',
  'A Cruise source, skill, version, or integrity hash changing during an active job is an exceptional internal recovery event, not a waiver or user-authorization boundary. Compare the bounded non-secret Cruise diff with the previously loaded instructions and determine which prior decisions it invalidates. If immaterial, refresh derived integrity evidence and continue. If material, revert or rework only affected Cruise-owned code changes and rerun their affected checks; preserve unrelated and user-owned work, and preserve non-code artifacts unless the changed instruction semantically invalidates them. Never use a blanket rollback solely for Cruise drift, and ask the user only if a separate genuine authorization boundary or unresolved ownership/product decision remains.',
  'A business-critical sandbox route closes its configured automated, data-policy, and main user-flow checks before production promotion. If those checks fail, retain the sandbox, report exact failures and rollback guidance, and leave production untouched.',
  'Continue to honor native host approvals for genuinely external or destructive effects, and request user input for material that is evidenced to be truly sensitive. Do not invent either condition from generic words such as private, repository, skill, prompt, or provider.',
].join(' ');

const CLOUD_TABLE = /\b(?:airtable|cloud|database|hosted|postgres|production|remote|supabase)\b[\s\S]{0,120}\b(?:record|row|table)\b|\b(?:record|row|table)\b[\s\S]{0,120}\b(?:airtable|cloud|database|hosted|postgres|production|remote|supabase)\b/iu;
const TABLE_MUTATION = /\b(?:adjust|alter|chang|delet|insert|migrat|modif|remov|updat|upsert|writ)\w*\b/iu;
const GENERIC_ADMIN_ONLY = /\b(?:contains?|has|includes?)\s+(?:only|solely)\s+(?:approved\s+)?(?:admins?|administrators?)\b/iu;
const NO_NON_ADMIN = /\bno\s+non[- ]admin(?:istrator)?\s+users?\b/iu;
const NON_ADMIN_PRESENT = /\b(?:contains?|has|includes?|involves?)\b[\s\S]{0,80}\bnon[- ]admin(?:istrator)?\s+users?\b|\bnon[- ]admin(?:istrator)?\s+users?\s+(?:are\s+)?(?:confirmed|exist|present)\b|\busers?\s+outside\s+(?:the\s+)?approved\s+admin(?:istrator)?\s+list\b/iu;
const BOOKING_SUPPORT_SITE = /\bbooking-support-site\b/iu;
const BOOKING_ADMIN_ONLY = /\bapproved\b[\s\S]{0,100}\b(?:assigned|role)\w*\b[\s\S]{0,60}\b(?:gm|owner)\b|\b(?:gm|owner)\b[\s\S]{0,60}\b(?:assigned|role)\w*\b[\s\S]{0,100}\bapproved\b/iu;
const APPROVED_LOCAL = /\b(?:host[- ]access[- ]approved|access[- ]approved|approved|authori[sz]ed)\s+(?:(?:ordinary|local|accessible|task[- ]relevant|sibling|private)\s+){0,4}(?:folders?|director(?:y|ies)|files?|repositor(?:y|ies)|workspaces?)\b|\b(?:local\s+workspaces?|workspace\s+files?|repository\s+files?)\b/iu;
const LOCAL_READ = /\b(?:read|search|inspect|browse|list|open|find|review|scan|summarize)\w*\b/iu;
const LOCAL_EDIT = /\b(?:edit|fix|patch|change|update|modify|write)\w*\b(?!\s+ownership\b)/iu;
const OWNED_REVERSIBLE_EDIT = /\b(?:minor|small)\s+reversible\b[\s\S]{0,160}\b(?:within|inside)\s+(?:the\s+|my\s+|our\s+)?(?:assigned\s+)?(?:write\s+|edit\s+)?ownership\b/iu;
const NATIVE_DENIAL = /\b(?:EACCES|EPERM|permission\s+denied|operation\s+not\s+permitted)\b|\b(?:host|sandbox|native\s+approval|automatic\s+approval\s+review)\s+(?:(?:has|was|explicitly)\s+){0,2}(?:denied|rejected)\b/iu;
// Local access is never authority for a second external or destructive effect.
const LOCAL_CONSEQUENTIAL_EFFECT = /\b(?:email|upload|transmit|export|deploy|publish|release|delete|drop|truncate|wipe|overwrite|remove|install|purchase|charge|chmod|sudo|execute)\w*\b|\brun\s+(?:arbitrary\s+)?(?:commands?|scripts?|code)\b|\b(?:external|third[- ]party)\s+(?:provider|service|destination)\b/iu;
const EXTERNAL_COPY = /\b(?:copy|cp|sync)\b[\s\S]{0,160}\b(?:to|into|onto)\s+['"`]?(?:https?|s?ftp|ssh):\/\//iu;
const NONLOCAL_EFFECT = new RegExp(`${LOCAL_CONSEQUENTIAL_EFFECT.source}|${EXTERNAL_COPY.source}|\\b(?:send|share)\\w*\\b`, 'iu');
const OUTSIDE_OWNERSHIP = /\b(?:outside|beyond)\s+(?:the\s+|my\s+|our\s+)?(?:assigned\s+)?(?:write\s+|edit\s+)?ownership\b/iu;
const UNAPPROVED_LOCAL = /\b(?:not\s+(?:yet\s+)?(?:approved|authori[sz]ed)|unapproved|unauthori[sz]ed|forbidden)\b/iu;

// Bind software-topic wording to one read clause; a following effect stays gated.
function localEffectText(value) {
  const topic = /\b(?:delete|deletion|deploy(?:ment)?|install(?:ation)?)\s+(?:(?:endpoint|handler|function|route)\s+)?(?:source\s+code|code|tests?|docs?|documentation)\b/giu;
  return value.replace(topic, (match, offset) => {
    const prefix = value.slice(Math.max(0, offset - 160), offset)
      .split(/[.;!?\r\n]|\b(?:and|then|but)\b/iu).at(-1);
    return LOCAL_READ.test(prefix) ? 'software topic' : match;
  });
}
const BOUNDED_CODEX_WORKER = /\b(?:bounded\s+(?:context|worker)|codex\s+(?:subagent|worker)|cruise\s+(?:goal[- ]skill|subagent|worker)|gpt-5\.6-(?:luna|terra|sol)|gpt-6-astra|managed\s+worker|(?:terra|astra)\s+(?:launch|worker))\b/iu;
const ROUTINE_DELEGATION = /\bsub[- ]?agents?\b|\b(?:another|additional|native|new(?:ly\s+spawned)?)\s+(?:[\w-]+\s+){0,3}agents?\b|\b(?:worker|agent)\s+model\b/iu;
const DELEGATION_PERMISSION_QUESTION = /(?:^|[.!?\n])\s*(?:may|can|could|shall|should)\s+(?:i|we|you)\b[^?]{0,600}\?/iu;
const MATERIAL_DELEGATION = /\b(?:not\s+requested|out(?:side)?\s+(?:the\s+)?scope|scope\s+(?:change|expansion)|which\s+(?:option|approach)|user\s+preference)\b|\b(?:different|unrelated|new|unapproved)\s+(?:external\s+)?(?:provider|service|destination)\b|\b(?:delete|drop|truncate|wipe|overwrite)\w*\s+(?:the\s+)?(?:production|live|customer|user)\b|\b(?:deploy|publish|release)\w*\b[\s\S]{0,80}\bproduction\b|\bforce[- ]push\b/iu;
const SENSITIVE_MENTION = /\b(?:api\s+key|access\s+token|authentication\s+secret|biometric\s+record|credit\s+card|credential\s+value|medical\s+record|patient\s+data|personal\s+data|password|private\s+key|secret\s+key|social\s+security\s+number)s?\b/giu;
const SENSITIVE_OPERATION = /\b(?:contains?|data|documents?|enter|expose|includes?|inspect|material|open|provide|read|review|send|share|upload)\w*\b/iu;
const SOFTWARE_ARTIFACT = /\b(?:source(?:\s+code)?|code|tests?|schemas?|documentation|docs)\b/iu;

const SOFTWARE_SUFFIX = /^(?:[- ](?:reset|handling|validation|redaction|rotation|storage|authentication|encryption|hashing))?\s+(?:source(?:\s+code)?|code|tests?|schemas?|documentation|docs)\b/iu;

function hasSensitiveMaterial(value, analysis) {
  // Classify each mention, never allow an entire request because it mentions code.
  // In particular, a second data object in a mixed disclosure remains sensitive.
  for (const { match, object } of analysis.mentions) {
    const before = value.slice(Math.max(0, match.index - 100), match.index);
    const after = value.slice(match.index + match[0].length, match.index + match[0].length + 100);
    if (object.excluded) continue;
    const concrete = /\b(?:actual|real|live|production|customer|patient)\s+$/iu.test(before)
      || /^\s+(?:values?|contents?|data|records?)\b/iu.test(after);
    const softwareSuffix = SOFTWARE_SUFFIX.test(after);
    const softwareTopic = /\b(?:source(?:\s+code)?|code|tests?|schemas?|documentation|docs)\s+(?:for|of|about)\s+$/iu.test(before);
    const functionalTopic = /^[- ](?:reset|handling|validation|redaction|rotation|storage|authentication|encryption|hashing)\b/iu.test(after)
      && SOFTWARE_ARTIFACT.test(before.split(/[.;!?]|\band\b/iu).at(-1));
    if (!concrete && (softwareSuffix || softwareTopic || functionalTopic)) continue;
    if (new RegExp(`${SENSITIVE_OPERATION.source}[\\s\\S]{0,80}$`, 'iu').test(value.slice(0, match.index))
      || new RegExp(`^[\\s\\S]{0,80}${SENSITIVE_OPERATION.source}`, 'iu').test(value.slice(match.index + match[0].length))) return true;
  }
  return false;
}
const MASSIVE_SURFACE = /\b(?:massive\s+(?:diff|surface)|overly\s+ambitious|repository[- ]wide\s+(?:change|rewrite)|rewrite\s+(?:everything|the\s+entire)|whole[- ]codebase\s+(?:change|rewrite)|hundreds\s+of\s+files)\b/iu;
const EXPLICIT_WHOLE_TABLE_NO_READ = /\b(?:explicit(?:ly)?|user\s+(?:said|requested|instructed))\b[\s\S]{0,120}\b(?:do\s+not|don't|never|prohibit|prevent)\b[\s\S]{0,80}\bread\w*\b[\s\S]{0,80}\btable\b|\btable\b[\s\S]{0,80}\b(?:do\s+not|don't|never|prohibit|prevent)\b[\s\S]{0,80}\bread\w*\b[\s\S]{0,120}\bexplicit(?:ly)?\b/iu;
const SANDBOX_MIGRATION = /\b(?:sandbox|preview|local|development|test)\b[\s\S]{0,140}\b(?:database|migration|migrations|sql|supabase)\b|\b(?:database|migration|migrations|sql|supabase)\b[\s\S]{0,140}\b(?:sandbox|preview|local|development|test)\b/iu;
const DERIVED_TRUST_REFRESH = /\b(?:digest|fingerprint|trust\s+record)\b[\s\S]{0,100}\b(?:refresh|rescan|update|updating)\w*\b|\b(?:refresh|rescan|update|updating)\w*\b[\s\S]{0,100}\b(?:digest|fingerprint|trust\s+record)\b/iu;
const PRODUCTION_READ_ONLY_SQL = /\bproduction\b[\s\S]{0,120}\b(?:read[- ]only|select\s+(?:query|sql)|sql\s+select)\b|\b(?:read[- ]only|select\s+(?:query|sql)|sql\s+select)\b[\s\S]{0,120}\bproduction\b/iu;
const CONTROLLER_PROVEN_MINOR_MIGRATION = /\b(?:migration\s+)?controller\b[\s\S]{0,120}\b(?:proved|proven|classified|verified)\b[\s\S]{0,80}\b(?:minor|additive|allowlisted|noncritical)\b|\b(?:minor|additive|allowlisted|noncritical)\b[\s\S]{0,80}\b(?:proved|proven|classified|verified)\b[\s\S]{0,120}\b(?:migration\s+)?controller\b/iu;
const SENSITIVE_PATH_TOKEN = /(?:^|[\s'"`(])((?:\.\.\/|\.\/|\/)?[^\s'"`():,;]*?(?:\.env(?:\.[^\s/'"`]*)?|[^\s/'"`]+\.env|(?:secret|secrets|credential|credentials|keys?|private[-_]?keys?)(?:\.[\w-]+)?(?:\/[^\s'"`]*)?|[^\s/'"`]*(?:[._-](?:secret|secrets|credential|credentials)[._-])[^\s/'"`]*|[^\s/'"`]+\.(?:key|pem|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)|\.(?:netrc|npmrc|pypirc)))(?=$|[\s'"`),:;.!?])/giu;
const SENSITIVE_READ_OR_SEND = /\b(?:cat|copy|enter|expose|include|inspect|open|provide|read|search|send|share|summarize|transmit|upload)\w*\b/iu;
const SPECULATIVE_WORKER_AUTHORIZATION = /\b(?:host\s+blocked|blocked\s+before\s+(?:any\s+)?(?:external\s+request|process\s+creation)|explicitly\s+(?:approve|authorize)|authorize\s+sending)\b[\s\S]{0,500}\b(?:codex\s+worker|cruise\s+(?:goal|worker)|gpt-5\.6-(?:luna|terra|sol)|gpt-6-astra|luna|terra|sol|astra)\b|\b(?:codex\s+worker|gpt-5\.6-(?:luna|terra|sol)|gpt-6-astra|luna|terra|sol|astra)\b[\s\S]{0,500}\b(?:explicitly\s+(?:approve|authorize)|authorize\s+sending)\b/iu;
const CRUISE_INTEGRITY_DRIFT = /\b(?:frozen|loaded|pinned|recorded)\s+(?:(?:cruise|goal)\s+)?(?:source|skill)\b[\s\S]{0,320}\b(?:reinstalled|current|updated|new)\s+(?:(?:cruise|goal)\s+)?(?:source|skill)\b[\s\S]{0,220}\b(?:hash(?:es)?|digest|version|integrity|waiver)\b|\bcruise(?::goal)?\s+integrity\b[\s\S]{0,220}\b(?:explicit\s+)?waiver\b/iu;

// An exclusion applies only to its object or a contiguous, explicit object list.
// Never carry it across another operation, clause, or arbitrary descriptive text.
function exclusionAnalysis(value) {
  const mentions = Array.from(value.matchAll(SENSITIVE_MENTION), (match) => ({ match }));
  const paths = Array.from(value.matchAll(SENSITIVE_PATH_TOKEN), (match) => ({
    match: { 0: match[1].replace(/[.?!]+$/u, ''), index: match.index + match[0].length - match[1].length },
  }));
  const objects = [
    ...mentions,
    ...Array.from(value.matchAll(/\b(?:credentials?|secrets?|private\s+keys?)\b/giu), (match) => ({ match })),
    ...paths,
  ];
  for (const entry of objects) {
    entry.index = entry.match.index;
    entry.end = entry.index + entry.match[0].length;
    // Keep a recognized software object whole so the next list connector starts
    // after "password hashing tests", not after the bare sensitive noun.
    entry.end += value.slice(entry.end, entry.end + 100).match(SOFTWARE_SUFFIX)?.[0].length ?? 0;
  }
  objects.sort((a, b) => a.index - b.index || b.end - a.end);
  let previous;
  for (const entry of objects) {
    // A mention inside a path inherits that path's exclusion; it cannot reopen
    // a gate. Same-start objects were sorted widest first.
    if (previous && entry.index < previous.end) {
      entry.object = previous;
      previous.end = Math.max(previous.end, entry.end);
      continue;
    }
    entry.object = entry;
    const prefix = value.slice(Math.max(0, entry.index - 200), entry.index);
    const localPrefix = prefix.split(/[\r\n]/u).at(-1);
    const connector = previous ? value.slice(previous.end, entry.index) : '';
    entry.excluded = /\b(?:without|never|do\s+not|don't|will\s+not|won't)\s+(?:(?:read|reading|expose|exposing|send|sending|share|sharing|include|including|access|accessing)\s+)(?:(?:any|the|actual|real)\s+){0,2}['"`]?$/iu.test(localPrefix)
      || /\b(?:exclude|excluding|omit|omitting|skip|no)\s+(?:(?:any|the|actual|real)\s+){0,2}['"`]?$/iu.test(localPrefix)
      || Boolean(previous?.excluded && !/[\r\n]/u.test(connector)
        && /^['"`]?\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)(?:(?:any|the|actual|real)\s+){0,2}['"`]?$/iu.test(connector))
      // Only standalone statements, never "passwords excluded from the report".
      || (/(?:^|[.!?;,\r\n])\s*['"`]?$/u.test(prefix)
        && /^['"`]?\s+(?:(?:values?|data)\s+)?(?:are|is)\s+(?:excluded|omitted)\s*(?:[.!?;]|$)/iu.test(value.slice(entry.end, entry.end + 100)));
    previous = entry;
  }
  return { mentions, paths };
}

function sensitivePathsIn(analysis) {
  return analysis.paths.filter(({ match, object }) => !object.excluded && isSensitivePath(match[0]))
    .map(({ match }) => match[0]);
}

export function isSpeculativeWorkerAuthorizationPause(value, { nativeApprovalDenied = false } = {}) {
  if (nativeApprovalDenied) return false;
  const visible = String(value ?? '').replace(/[^\S\r\n]+/gu, ' ').trim();
  if (!SPECULATIVE_WORKER_AUTHORIZATION.test(visible) && !DELEGATION_PERMISSION_QUESTION.test(visible)) return false;
  return automaticDelegationAuthorization({ questions: [{ id: 'coordination', question: visible }] }) !== null;
}

export function isCruiseIntegrityDriftAuthorizationPause(value, { nativeApprovalDenied = false } = {}) {
  if (nativeApprovalDenied) return false;
  const visible = String(value ?? '').replace(/[^\S\r\n]+/gu, ' ').trim();
  if (!CRUISE_INTEGRITY_DRIFT.test(visible)) return false;
  return classifyCruiseAuthorization(visible).reason === 'cruise-integrity-drift-recovery';
}

function authorizationQuestionText(question) {
  const options = Array.isArray(question.options) ? question.options : [];
  // Newlines prevent an exclusion in one option from masking another object.
  return [question.header, question.question, ...options.flatMap((option) =>
    typeof option === 'string' ? [option] : [option?.label, option?.description, option?.value])]
    .filter((value) => typeof value === 'string' && value).join('\n');
}

/** Resolve bounded local work; access does not confer write or disclosure authority. */
export function automaticLocalAuthorization(params = {}, { nativeApprovalDenied = false } = {}) {
  if (nativeApprovalDenied || !Array.isArray(params.questions) || params.questions.length === 0) return null;
  const answers = {};
  for (const question of params.questions) {
    if (typeof question?.id !== 'string' || !question.id) return null;
    const visible = authorizationQuestionText(question);
    const effects = localEffectText(visible);
    if (!APPROVED_LOCAL.test(visible) || UNAPPROVED_LOCAL.test(visible) || NATIVE_DENIAL.test(visible)
      || MATERIAL_DELEGATION.test(effects) || NONLOCAL_EFFECT.test(effects)) return null;
    if (!(LOCAL_READ.test(visible) || LOCAL_EDIT.test(visible))
      || (LOCAL_EDIT.test(visible) && (!OWNED_REVERSIBLE_EDIT.test(visible) || OUTSIDE_OWNERSHIP.test(visible)))) return null;
    const analysis = exclusionAnalysis(visible);
    // Skipping one never-read path cannot authorize a separate sensitive object.
    const dataMentions = analysis.mentions.filter(({ object }) => !analysis.paths.some((path) =>
      path.object === object && isSensitivePath(path.match[0])));
    if (hasSensitiveMaterial(visible, { mentions: dataMentions })) return null;
    const boundary = classifyCruiseAuthorization(visible);
    if (boundary.action === AUTHORIZATION_ACTION.skipSensitive) {
      answers[question.id] = { answers: [SENSITIVE_PATH_SKIP_ANSWER] };
    } else if (boundary.action === AUTHORIZATION_ACTION.proceed && boundary.reason === 'approved-local-context') {
      answers[question.id] = { answers: [PREAUTHORIZED_PROCEED_ANSWER
        + ' Stay within the current task, skip never-read and ignored paths, and keep edits within assigned write ownership. Native host permissions remain authoritative.'] };
    } else return null;
  }
  return { answers };
}

/** Resolve only internal coordination; never a worker's additional effects. */
export function automaticDelegationAuthorization(params = {}, { nativeApprovalDenied = false } = {}) {
  if (nativeApprovalDenied || !Array.isArray(params.questions) || params.questions.length === 0) return null;
  const answers = {};
  for (const question of params.questions) {
    if (typeof question?.id !== 'string' || !question.id) return null;
    const visible = authorizationQuestionText(question);
    const effects = localEffectText(visible);
    if (!(ROUTINE_DELEGATION.test(visible) || BOUNDED_CODEX_WORKER.test(visible))
      || MATERIAL_DELEGATION.test(effects)) return null;
    const boundary = classifyCruiseAuthorization(visible);
    if (boundary.action !== AUTHORIZATION_ACTION.proceed
      || !['routine-delegation', 'bounded-codex-worker-context', 'approved-local-context'].includes(boundary.reason)) return null;
    answers[question.id] = { answers: [ROUTINE_DELEGATION_ANSWER] };
  }
  return { answers };
}

export const WORKER_AUTHORIZATION_RECOVERY_INSTRUCTIONS = [
  'Check the preceding disclosure-authorization pause against the actual host/tool result before proceeding. An unsupported pause must not be repeated; an actual denial must be honored.',
  NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS,
  'Approved local source and bounded Codex worker context require no disclosure authorization, regardless of whether the worker is Luna, Terra, Sol, or Astra.',
  NEVER_READ_INSTRUCTIONS,
  'If no native denial applies, continue using a bounded context capsule. Do not send a complete skill or repository when focused excerpts suffice, and do not ask the user another authorization question for that already-authorized worker launch.',
].join(' ');

export const CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS = [
  'The preceding Cruise source/hash mismatch is an exceptional internal recovery event, not a waiver or user-authorization boundary. Do not repeat the waiver request and do not stop or restart the job solely because Cruise changed.',
  'Without reading, searching, summarizing, or fingerprinting sensitive paths, compare only the bounded relevant Cruise instruction diff against the previously loaded behavior. Decide whether that diff invalidates prior implementation decisions or outputs.',
  'If the change is immaterial, refresh only derived integrity or assurance evidence and continue. If it is material, selectively revert or rework only Cruise-owned code changes that depended on invalidated instructions, then rerun the affected steps and checks. Preserve user-owned and unrelated work. Preserve Markdown and other non-code artifacts unless the changed instruction semantically invalidates them. Use a whole-job rollback only when the bounded comparison proves the foundations of the entire Cruise-owned code surface invalid.',
  'Continue without human intervention unless a separate genuine native approval, sensitive-data boundary, destructive effect, unresolved ownership conflict, or material product decision remains.',
  NEVER_READ_INSTRUCTIONS,
].join(' ');

/**
 * Classify only evidence stated in the proposed authorization boundary. Generic
 * privacy language is not evidence that approved local material is sensitive.
 */
export function classifyCruiseAuthorization(value, { nativeApprovalDenied = false } = {}) {
  const visible = String(value ?? '').replace(/[^\S\r\n]+/gu, ' ').trim();
  const effects = localEffectText(visible);
  if (nativeApprovalDenied || NATIVE_DENIAL.test(visible)) {
    return Object.freeze({ action: AUTHORIZATION_ACTION.nativePermissions, reason: 'native-permission-denied' });
  }
  const cloudTable = CLOUD_TABLE.test(visible);
  const tableMutation = TABLE_MUTATION.test(visible);
  const analysis = exclusionAnalysis(visible);
  const sensitivePaths = sensitivePathsIn(analysis);
  const delegation = ROUTINE_DELEGATION.test(visible) || BOUNDED_CODEX_WORKER.test(visible);

  if (cloudTable && EXPLICIT_WHOLE_TABLE_NO_READ.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.respectNoRead,
      reason: 'explicit-whole-table-no-read',
    });
  }

  if (sensitivePaths.length > 0 && SENSITIVE_READ_OR_SEND.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.skipSensitive,
      reason: 'sensitive-path-never-read',
    });
  }

  if (hasSensitiveMaterial(visible, analysis)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.requestUser,
      reason: 'explicit-sensitive-material',
    });
  }

  if (CRUISE_INTEGRITY_DRIFT.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'cruise-integrity-drift-recovery',
    });
  }

  if (delegation && MATERIAL_DELEGATION.test(effects)) {
    return Object.freeze({ action: AUTHORIZATION_ACTION.requestUser, reason: 'material-delegated-effect' });
  }

  if (APPROVED_LOCAL.test(visible)
    && (MATERIAL_DELEGATION.test(effects) || LOCAL_CONSEQUENTIAL_EFFECT.test(effects) || EXTERNAL_COPY.test(effects)
      || (!delegation && NONLOCAL_EFFECT.test(effects))
      || UNAPPROVED_LOCAL.test(visible)
      || (LOCAL_EDIT.test(visible) && OUTSIDE_OWNERSHIP.test(visible)))) {
    return Object.freeze({ action: AUTHORIZATION_ACTION.requestUser, reason: 'material-local-effect' });
  }

  if (delegation && /\bread[- ]only\s+review\b/iu.test(visible)) {
    return Object.freeze({ action: AUTHORIZATION_ACTION.proceed, reason: 'routine-delegation' });
  }

  if (DERIVED_TRUST_REFRESH.test(visible) && !/\b(?:production|secret|credential|private\s+key)\b/iu.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'derived-trust-artifact-refresh',
    });
  }

  if (SANDBOX_MIGRATION.test(visible) && !/\bproduction\b/iu.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'verified-sandbox-migration',
    });
  }

  if (PRODUCTION_READ_ONLY_SQL.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'production-read-only-sql',
    });
  }

  if (CONTROLLER_PROVEN_MINOR_MIGRATION.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'controller-proven-minor-migration',
    });
  }

  if (cloudTable && tableMutation) {
    if (NON_ADMIN_PRESENT.test(visible) && !NO_NON_ADMIN.test(visible)) {
      return Object.freeze({
        action: AUTHORIZATION_ACTION.requestUser,
        reason: 'cloud-table-non-admin-users-confirmed',
      });
    }
    const adminOnly = NO_NON_ADMIN.test(visible) || (
      BOOKING_SUPPORT_SITE.test(visible)
        ? BOOKING_ADMIN_ONLY.test(visible)
        : GENERIC_ADMIN_ONLY.test(visible)
    );
    if (adminOnly) {
      return Object.freeze({
        action: AUTHORIZATION_ACTION.proceed,
        reason: 'cloud-table-admin-only',
      });
    }
    return Object.freeze({
      action: AUTHORIZATION_ACTION.inspectMinimum,
      reason: 'cloud-table-membership-unknown',
    });
  }

  if (cloudTable) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'cloud-table-read-preauthorized',
    });
  }

  if (MASSIVE_SURFACE.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.decompose,
      reason: 'massive-affected-surface',
    });
  }

  if (ROUTINE_DELEGATION.test(visible)) {
    return Object.freeze({ action: AUTHORIZATION_ACTION.proceed, reason: 'routine-delegation' });
  }

  if (APPROVED_LOCAL.test(visible) || BOUNDED_CODEX_WORKER.test(visible)) {
    return Object.freeze({
      action: AUTHORIZATION_ACTION.proceed,
      reason: APPROVED_LOCAL.test(visible)
        ? 'approved-local-context'
        : 'bounded-codex-worker-context',
    });
  }

  return Object.freeze({
    action: AUTHORIZATION_ACTION.nativePermissions,
    reason: 'no-cruise-specific-boundary',
  });
}
