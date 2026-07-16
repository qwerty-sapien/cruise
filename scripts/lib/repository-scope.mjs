import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

const NON_PRODUCT_DIRECTORY_NAMES = new Set([
  '.cache',
  '.hypothesis',
  '.mypy_cache',
  '.nox',
  '.npm',
  '.parcel-cache',
  '.pnpm-store',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.turbo',
  '__pycache__',
  'node_modules',
]);

const NON_PRODUCT_FILE_NAMES = new Set([
  '.DS_Store',
  '.eslintcache',
  '.stylelintcache',
  'Thumbs.db',
  'desktop.ini',
]);

const AUTO_CLEAR_DIRECTORY_NAMES = new Set(
  [...NON_PRODUCT_DIRECTORY_NAMES].filter((name) => name !== 'node_modules'),
);

function portable(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Return true for host metadata and disposable caches that are outside Cruise's
 * product-repository scope. This policy is deliberately independent of Git's
 * mutable ignore configuration so tracked or newly-created noise stays inert.
 */
export function isNonProductRepositoryPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalized = portable(path).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || normalized === '.') return false;
  const segments = normalized.split('/');
  const name = segments.at(-1);

  if (segments.some((segment) => NON_PRODUCT_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some((segment, index) => (
    (segment === '.yarn' && segments[index + 1] === 'cache')
    || (segment === '.next' && segments[index + 1] === 'cache')
  ))) return true;
  return NON_PRODUCT_FILE_NAMES.has(name)
    || name.startsWith('._')
    || /\.py[co]$/u.test(name)
    || /\.swp$/u.test(name)
    || name.endsWith('~');
}

export function isAutoClearRepositoryPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalized = portable(path).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || normalized === '.') return false;
  const segments = normalized.split('/');
  const name = segments.at(-1);
  if (segments.some((segment) => AUTO_CLEAR_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some((segment, index) => (
    (segment === '.yarn' && segments[index + 1] === 'cache')
    || (segment === '.next' && segments[index + 1] === 'cache')
  ))) return true;
  return NON_PRODUCT_FILE_NAMES.has(name)
    || name.startsWith('._')
    || /\.py[co]$/u.test(name)
    || /\.swp$/u.test(name)
    || name.endsWith('~');
}

/** Remove disposable artifacts without following links or entering control roots. */
export function clearDisposableRepositoryArtifacts(repositoryRoot) {
  const result = { removed: 0, failed: 0 };
  const visit = (directory, prefix = '') => {
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      result.failed += 1;
      return;
    }
    for (const child of children) {
      if (prefix === '' && ['.git', '.cruise'].includes(child.name)) continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(directory, child.name);
      if (isAutoClearRepositoryPath(path)) {
        try {
          const metadata = lstatSync(absolute);
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            rmSync(absolute, { recursive: true, force: true });
          } else {
            unlinkSync(absolute);
          }
          result.removed += 1;
        } catch (error) {
          if (error?.code !== 'ENOENT') result.failed += 1;
        }
        continue;
      }
      if (child.isDirectory() && !child.isSymbolicLink() && !isNonProductRepositoryPath(path)) {
        visit(absolute, path);
      }
    }
  };
  visit(repositoryRoot);
  return Object.freeze(result);
}

// Apply the same invariant inside Git itself so binary diffs and status output
// never contain excluded paths before they are hashed or exposed downstream.
export const NON_PRODUCT_GIT_PATHSPECS = Object.freeze([
  ':(exclude,glob)**/.DS_Store',
  ':(exclude,glob)**/Thumbs.db',
  ':(exclude,glob)**/desktop.ini',
  ':(exclude,glob)**/._*',
  ':(exclude,glob)**/.eslintcache',
  ':(exclude,glob)**/.stylelintcache',
  ':(exclude,glob)**/*.pyc',
  ':(exclude,glob)**/*.pyo',
  ':(exclude,glob)**/*.swp',
  ':(exclude,glob)**/*~',
  ...[
    '.cache',
    '.hypothesis',
    '.mypy_cache',
    '.nox',
    '.npm',
    '.parcel-cache',
    '.pnpm-store',
    '.pytest_cache',
    '.ruff_cache',
    '.tox',
    '.turbo',
    '__pycache__',
    'node_modules',
  ].map((name) => `:(exclude,glob)**/${name}/**`),
  ':(exclude,glob)**/.yarn/cache/**',
  ':(exclude,glob)**/.next/cache/**',
]);

export function repositoryGitPathspec({ excludeCruise = true } = {}) {
  return [
    '.',
    ...(excludeCruise ? [':(exclude).cruise', ':(exclude).cruise/**'] : []),
    ...NON_PRODUCT_GIT_PATHSPECS,
  ];
}
