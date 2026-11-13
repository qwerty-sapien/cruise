import { basename } from 'node:path';

const DOTENV_FILE = /^(?:\.env(?:\..+)?|[^/]+\.env)$/iu;
const SENSITIVE_BASENAME = /(?:^|[._-])(?:credentials?|secrets?|private[-_]?keys?)(?:[._-]|$)/iu;
const SENSITIVE_DIRECTORY = /(?:^|\/)(?:credentials?|secrets?|private[-_]?keys?|keys)(?:\/|$)/iu;
const PRIVATE_KEY_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:key|pem|p12|pfx))$/iu;
const AUTH_CONFIG_FILE = /^(?:\.netrc|\.npmrc|\.pypirc)$/iu;
const ASSIGNMENT = /(?:^|[\s'"`])(?:export\s+)?([A-Z][A-Z0-9_]*)\s*[=:]\s*(?!["']?<?(?:redacted|omitted|unset)>?["']?(?:[\s,}]|$))["']?[^\s"'#]{4,}/gu;
const SECRET_VARIABLE = /^(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)$|(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/u;
const PRIVATE_KEY_MATERIAL = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const BEARER_MATERIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u;
const SENSITIVE_ACCESS = /\b(?:cat|copy|enter|expose|include|inspect|open|provide|read|search|send|share|summarize|transmit|upload)\w*\b/iu;
const SENSITIVE_EXCLUSION = /\b(?:do\s+not|don't|never|exclude|excluded|excluding|omit|omitted|skip|without|won't|will\s+not|no)\b[\s\S]{0,100}(?:\.env|credentials?|secrets?|private\s+keys?)|(?:\.env|credentials?|secrets?|private\s+keys?)[\s\S]{0,100}\b(?:do\s+not|don't|never|exclude|excluded|excluding|omit|omitted|skip|without|won't|will\s+not|no)\b/iu;

function normalizedPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

function matchesExplicitPath(path, entries) {
  return entries.some((entry) => {
    const denied = normalizedPath(entry).replace(/\/$/u, '');
    return denied && (path === denied || path.startsWith(`${denied}/`));
  });
}

/** High-confidence paths Cruise must never open or send to a worker. */
export function isSensitivePath(value, { explicitSensitivePaths = [] } = {}) {
  const path = normalizedPath(value);
  if (!path) return false;
  if (matchesExplicitPath(path, explicitSensitivePaths)) return true;
  const name = basename(path);
  return DOTENV_FILE.test(name)
    || AUTH_CONFIG_FILE.test(name)
    || PRIVATE_KEY_FILE.test(name)
    || SENSITIVE_DIRECTORY.test(path)
    || SENSITIVE_BASENAME.test(name);
}

export function assertReadablePath(value, options = {}) {
  if (isSensitivePath(value, options)) {
    const error = new Error(`sensitive path is never readable by Cruise: ${normalizedPath(value)}`);
    error.code = 'CRUISE_SENSITIVE_PATH';
    throw error;
  }
  return value;
}

export function sensitivePathReferences(value, options = {}) {
  const candidates = String(value ?? '')
    .split(/[\s'"`()\[\]{},;]+/u)
    .map((item) => item.replace(/^[-=:]+/u, '').replace(/:\d+(?:-\d+)?$/u, '').replace(/[.:!?]+$/u, ''))
    .filter(Boolean);
  return candidates.filter((candidate) => isSensitivePath(candidate, options));
}

export function assertNoSensitivePathReference(value, label = 'value', options = {}) {
  const [path] = sensitivePathReferences(value, options);
  if (path) {
    const error = new Error(`${label} references a sensitive path that Cruise must not read: ${path}`);
    error.code = 'CRUISE_SENSITIVE_PATH';
    throw error;
  }
  return value;
}

export function requestsSensitivePathAccess(value, options = {}) {
  const text = String(value ?? '');
  return sensitivePathReferences(text, options).length > 0
    && SENSITIVE_ACCESS.test(text)
    && !SENSITIVE_EXCLUSION.test(text);
}

export function assertNoSensitiveAccessRequest(value, label = 'value', options = {}) {
  if (requestsSensitivePathAccess(value, options)) {
    const error = new Error(`${label} requests access to a sensitive path that Cruise must never read`);
    error.code = 'CRUISE_SENSITIVE_PATH';
    throw error;
  }
  return value;
}

/** Reject high-confidence credential material before a worker request is built. */
export function containsSecretMaterial(value) {
  const text = String(value ?? '');
  return [...text.matchAll(ASSIGNMENT)].some((match) => SECRET_VARIABLE.test(match[1]))
    || PRIVATE_KEY_MATERIAL.test(text)
    || BEARER_MATERIAL.test(text);
}

export function assertNoSecretMaterial(value, label = 'value') {
  if (containsSecretMaterial(value)) {
    const error = new Error(`${label} contains secret material and cannot be sent to a Cruise worker`);
    error.code = 'CRUISE_SECRET_MATERIAL';
    throw error;
  }
  return value;
}

/** Git exclusions are applied before diff/status commands inspect worktree data. */
export const SENSITIVE_GIT_PATHSPECS = Object.freeze([
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.env',
  ':(exclude,glob)**/secret/**',
  ':(exclude,glob)**/secrets/**',
  ':(exclude,glob)**/credential/**',
  ':(exclude,glob)**/credentials/**',
  ':(exclude,glob)**/key/**',
  ':(exclude,glob)**/keys/**',
  ':(exclude,glob)**/private-key/**',
  ':(exclude,glob)**/private_keys/**',
  ':(exclude,glob)**/*secret*',
  ':(exclude,glob)**/*credential*',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.p12',
  ':(exclude,glob)**/*.pfx',
  ':(exclude,glob)**/id_rsa',
  ':(exclude,glob)**/id_dsa',
  ':(exclude,glob)**/id_ecdsa',
  ':(exclude,glob)**/id_ed25519',
  ':(exclude,glob)**/.netrc',
  ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/.pypirc',
]);

export function sensitiveGitPathspecs(explicitSensitivePaths = []) {
  return [
    ...SENSITIVE_GIT_PATHSPECS,
    ...explicitSensitivePaths.map((path) => `:(exclude,top,literal)${normalizedPath(path).replace(/\/$/u, '')}`),
  ];
}

export const NEVER_READ_INSTRUCTIONS = [
  'Never read, search, summarize, fingerprint, or send .env files, dotenv variants, credential or secret files/directories, private-key files, or paths the user explicitly marks as secret.',
  'Skip those paths automatically and continue with safe bounded context; their presence is not a reason to ask the user for disclosure authorization.',
].join(' ');
