#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const [
  direction,
  name,
  external,
  expectedParentDev,
  expectedParentIno,
  expectedKind,
  expectedMode,
  expectedSize,
  expectedSha256,
  expectedTargetDev,
  expectedTargetIno,
] = process.argv.slice(2);
const validatesExistingTarget = ['replace-into-parent', 'unlink-in-parent'].includes(direction);
if (
  !['replace-into-parent', 'link-into-parent', 'unlink-in-parent'].includes(direction)
  || typeof name !== 'string'
  || !/^[^/\\\0]+$/u.test(name)
  || name === '.'
  || name === '..'
  || (direction !== 'unlink-in-parent' && (typeof external !== 'string' || !isAbsolute(external)))
  || !/^\d+$/u.test(expectedParentDev ?? '')
  || !/^\d+$/u.test(expectedParentIno ?? '')
  || (validatesExistingTarget && (
    !['file', 'symlink'].includes(expectedKind)
    || !/^\d+$/u.test(expectedMode ?? '')
    || !/^\d+$/u.test(expectedSize ?? '')
    || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')
    || !/^\d+$/u.test(expectedTargetDev ?? '')
    || !/^\d+$/u.test(expectedTargetIno ?? '')
  ))
) {
  fail('invalid pinned rename protocol');
} else {
  try {
    // The host starts this process with cwd set to the preflighted product
    // parent. If the pathname was swapped before spawn, this identity check
    // rejects it. If it is swapped afterward, cwd remains pinned to the
    // original directory inode and the basename-relative rename cannot follow
    // the replacement symlink.
    const parent = await lstat('.');
    if (
      !parent.isDirectory()
      || String(parent.dev) !== expectedParentDev
      || String(parent.ino) !== expectedParentIno
    ) {
      throw new Error('pinned restore parent identity changed');
    }

    const assertExpectedTarget = async () => {
      const prior = await lstat(name);
      const kind = prior.isSymbolicLink() ? 'symlink' : prior.isFile() ? 'file' : 'unsafe';
      let bytes;
      if (kind === 'file') {
        const handle = await open(name, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (opened.dev !== prior.dev || opened.ino !== prior.ino || !opened.isFile()) {
            throw new Error('pinned restore target changed while opening');
          }
          bytes = await handle.readFile();
          const after = await handle.stat();
          if (
            after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== bytes.length
            || after.mtimeMs !== opened.mtimeMs
            || after.ctimeMs !== opened.ctimeMs
          ) {
            throw new Error('pinned restore target changed while reading');
          }
        } finally {
          await handle.close();
        }
      } else if (kind === 'symlink') {
        bytes = await readlink(name, { encoding: 'buffer' });
        const after = await lstat(name);
        if (after.dev !== prior.dev || after.ino !== prior.ino || !after.isSymbolicLink()) {
          throw new Error('pinned restore symlink changed while reading');
        }
      } else {
        throw new Error('pinned restore target kind is unsafe');
      }
      const finalTarget = await lstat(name);
      if (
        finalTarget.dev !== prior.dev
        || finalTarget.ino !== prior.ino
        || (finalTarget.mode & 0o7777) !== (prior.mode & 0o7777)
        || finalTarget.size !== prior.size
        || finalTarget.mtimeMs !== prior.mtimeMs
        || finalTarget.ctimeMs !== prior.ctimeMs
      ) {
        throw new Error('pinned restore target changed before mutation');
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (
        kind !== expectedKind
        || String(prior.mode & 0o7777) !== expectedMode
        || String(bytes.length) !== expectedSize
        || digest !== expectedSha256
        || String(prior.dev) !== expectedTargetDev
        || String(prior.ino) !== expectedTargetIno
      ) {
        throw new Error('pinned restore target differs from the incident-bound snapshot');
      }
    };

    if (direction === 'link-into-parent') {
      const source = await lstat(external);
      if (source.isFile()) await link(external, name);
      else if (source.isSymbolicLink()) await symlink(await readlink(external), name);
      else throw new Error('pinned no-clobber source must be a file or symlink');
    } else {
      await assertExpectedTarget();
      if (direction === 'replace-into-parent') await rename(external, name);
      else await unlink(name);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
