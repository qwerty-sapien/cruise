#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function safeName(value) {
  return typeof value === 'string'
    && /^[^/\\\0]+$/u.test(value)
    && value !== '.'
    && value !== '..';
}

const [name, temporaryName, sourcePath, expectedDev, expectedIno] = process.argv.slice(2);
if (
  !safeName(name)
  || !safeName(temporaryName)
  || name === temporaryName
  || typeof sourcePath !== 'string'
  || !isAbsolute(sourcePath)
  || !/^\d+$/u.test(expectedDev ?? '')
  || !/^\d+$/u.test(expectedIno ?? '')
) {
  fail('invalid pinned worker-report commit protocol');
} else {
  let source = null;
  let temporary = null;
  try {
    // The host launches this process with cwd set to the report parent. The
    // identity check rejects a pathname swap before launch; after launch cwd
    // pins the original directory inode, so all child names remain relative to
    // that inode and cannot follow a replacement parent symlink.
    const parent = await lstat('.');
    if (
      parent.isSymbolicLink()
      || !parent.isDirectory()
      || String(parent.dev) !== expectedDev
      || String(parent.ino) !== expectedIno
    ) {
      throw new Error('pinned worker-report parent identity changed');
    }

    source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const sourceBefore = await source.stat();
    if (!sourceBefore.isFile()) throw new Error('worker-report source must be a regular file');

    // Copy to a private, no-follow, no-clobber sibling first. Linking that
    // sibling publishes the complete bytes atomically and fails if the final
    // report appeared after admission. This also works across filesystems.
    temporary = await open(
      temporaryName,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const bytes = await source.readFile();
    const sourceAfter = await source.stat();
    if (
      sourceAfter.dev !== sourceBefore.dev
      || sourceAfter.ino !== sourceBefore.ino
      || sourceAfter.size !== sourceBefore.size
      || bytes.length !== sourceBefore.size
    ) {
      throw new Error('worker-report source changed while committing');
    }
    await temporary.writeFile(bytes);
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await link(temporaryName, name);
    await unlink(temporaryName);
  } catch (error) {
    await temporary?.close().catch(() => {});
    await unlink(temporaryName).catch(() => {});
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await source?.close().catch(() => {});
  }
}
