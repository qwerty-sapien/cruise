import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The only durable state Cruise creates in a repository. */
export const ORIGIN_NOTE_PATH = '.cruise/ORIGIN.md';

function assertPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('Cruise requires a non-empty request.');
  }
  return prompt;
}

async function originDirectory(cwd) {
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${directory} must be a directory.`);
  }
  return directory;
}

/**
 * Record exactly what the user requested.  This is intentionally a note, not
 * an authority: no digest, baseline, timestamp, or previous-value check is
 * attached to it.  A later explicit Cruise request replaces the note.
 */
export async function writeOriginPrompt(cwd, prompt) {
  const body = assertPrompt(prompt);
  const directory = await originDirectory(cwd);
  const path = join(directory, 'ORIGIN.md');
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`${path} must be a regular file.`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 });
  return Object.freeze({ path, prompt: body });
}

export async function readOriginPrompt(cwd) {
  return readFile(join(cwd, ORIGIN_NOTE_PATH), 'utf8');
}
