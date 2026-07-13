import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/u;

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping.`);
  }
  return value;
}

function assertSafeRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !SAFE_RELATIVE_PATH.test(value) ||
    value.startsWith('./') ||
    value.includes('//') ||
    resolve('/', value) !== join('/', value)
  ) {
    throw new Error(`${label} must be a normalized repository-relative path.`);
  }
  return value;
}

/**
 * Compute the stable digest for the complete immutable project + milestone
 * contract. Mutable runtime, discovery, and phase artifacts do not belong in
 * this manifest.
 */
export function milestoneContractDigest(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('A milestone contract digest requires at least one artifact.');
  }
  const seen = new Set();
  const records = artifacts.map((candidate, index) => {
    const artifact = requireRecord(candidate, `artifacts[${index}]`);
    const path = assertSafeRelativePath(artifact.path, `artifacts[${index}].path`);
    if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      throw new Error(`artifacts[${index}].sha256 must be a lowercase SHA-256 digest.`);
    }
    if (seen.has(path)) throw new Error(`Duplicate locked artifact path: ${path}.`);
    seen.add(path);
    return { path, sha256: artifact.sha256 };
  });
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const hash = createHash('sha256');
  hash.update('cruise-milestone-contract-v1\0');
  for (const record of records) {
    hash.update(record.path);
    hash.update('\0');
    hash.update(record.sha256);
    hash.update('\0');
    hash.update('\0');
  }
  return hash.digest('hex');
}
