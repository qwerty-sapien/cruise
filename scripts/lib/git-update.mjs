import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  inspectPluginCache,
  pluginDigestDetail,
  resolvePluginCacheRoot,
} from './doctor-plugin-cache.mjs';

export const GIT_UPDATE_EVENTS = Object.freeze([
  'post-merge',
  'post-rewrite',
  'post-checkout',
]);

export const MANAGED_HOOK_MARKER = 'cruise-managed-git-hook-v1';
export const DEFAULT_PLUGIN_READY_TIMEOUT_MS = 120_000;
const ZERO_OID_PATTERN = /^0+$/u;
const FALLBACK_TEMPLATE_EXCLUDE = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
`;
const FALLBACK_TEMPLATE_DESCRIPTION = 'Unnamed repository; edit this file \'description\' to name the repository.\n';

function assertEvent(event) {
  if (!GIT_UPDATE_EVENTS.includes(event)) {
    throw new Error(`unsupported Cruise Git update event: ${event}`);
  }
  return event;
}

export function shouldRunGitUpdateHook(event, args = []) {
  assertEvent(event);
  if (event === 'post-rewrite') return args[0] === 'rebase';
  if (event === 'post-checkout') return ZERO_OID_PATTERN.test(args[0] ?? '');
  return true;
}

export function renderGitUpdateHook(event) {
  assertEvent(event);
  const eventGate = event === 'post-rewrite'
    ? 'test "${1:-}" = "rebase" || exit 0'
    : event === 'post-checkout'
      ? `case "\${1:-}" in
  ''|*[!0]*) exit 0 ;;
esac`
      : ':';
  return `#!/bin/sh
# ${MANAGED_HOOK_MARKER}
set -u

legacy="$0.cruise-original"
if test -x "$legacy"; then
  "$legacy" "$@" || exit $?
fi

${eventGate}

test "\${CRUISE_AUTO_UPDATE_ACTIVE:-}" != "1" || exit 0
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
manifest="$root/.codex-plugin/plugin.json"
test -f "$manifest" || exit 0
origin=$(git config --get remote.origin.url 2>/dev/null || :)
case "$origin" in
  https://github.com/qwerty-sapien/cruise|https://github.com/qwerty-sapien/cruise.git|git@github.com:qwerty-sapien/cruise|git@github.com:qwerty-sapien/cruise.git|ssh://git@github.com/qwerty-sapien/cruise|ssh://git@github.com/qwerty-sapien/cruise.git) ;;
  *) exit 0 ;;
esac
updater=$(command -v cruise 2>/dev/null) || {
  echo "Cruise update hook needs the installed cruise client on PATH." >&2
  exit 1
}

exec "$updater" hooks run --event ${event} -C "$root"
`;
}

async function readExisting(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function installManagedGitHook(path, event) {
  const content = renderGitUpdateHook(event);
  const existing = await readExisting(path);
  const chainedPath = `${path}.cruise-original`;
  if (existing !== null && !existing.includes(MANAGED_HOOK_MARKER)) {
    if (await readExisting(chainedPath) !== null) {
      throw new Error(`cannot preserve existing Git hook because ${chainedPath} already exists`);
    }
    await rename(path, chainedPath);
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.cruise-new-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o755, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o755);
  return Object.freeze({
    event,
    path,
    chained: existing !== null && !existing.includes(MANAGED_HOOK_MARKER),
  });
}

function runGit(args, { cwd, env = process.env } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (
    result.status === 1
    && args[0] === 'config'
    && args.includes('--get')
  ) {
    return '';
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function expandHome(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return resolve(path);
}

async function writeIfAbsent(path, content) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function seedManagedGitTemplate({ templateRoot, repositoryRoot, git }) {
  const execPath = git(['--exec-path'], { cwd: repositoryRoot });
  const defaultTemplate = join(dirname(dirname(execPath)), 'share', 'git-core', 'templates');
  await mkdir(templateRoot, { recursive: true });
  try {
    await cp(defaultTemplate, templateRoot, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeIfAbsent(join(templateRoot, 'info', 'exclude'), FALLBACK_TEMPLATE_EXCLUDE);
  await writeIfAbsent(join(templateRoot, 'description'), FALLBACK_TEMPLATE_DESCRIPTION);
}

export async function installGitUpdateHooks({
  repositoryRoot,
  templateRoot = null,
  home = homedir(),
  git = runGit,
} = {}) {
  const root = await realpath(resolve(repositoryRoot));
  const hooksValue = git(['rev-parse', '--git-path', 'hooks'], { cwd: root });
  const repositoryHooks = resolve(root, hooksValue);
  let globalTemplate = templateRoot;
  let managedTemplate = false;
  if (!globalTemplate) {
    const cruiseTemplate = join(home, '.config', 'cruise', 'git-template');
    const configured = git(['config', '--global', '--get', 'init.templateDir'], { cwd: root });
    if (configured) {
      globalTemplate = expandHome(configured, home);
      managedTemplate = resolve(globalTemplate) === resolve(cruiseTemplate);
    } else {
      globalTemplate = cruiseTemplate;
      managedTemplate = true;
      git(['config', '--global', 'init.templateDir', globalTemplate], { cwd: root });
    }
  }
  globalTemplate = resolve(globalTemplate);
  if (managedTemplate) {
    await seedManagedGitTemplate({ templateRoot: globalTemplate, repositoryRoot: root, git });
  }
  const installed = [];
  for (const event of GIT_UPDATE_EVENTS) {
    installed.push(await installManagedGitHook(join(repositoryHooks, event), event));
    installed.push(await installManagedGitHook(join(globalTemplate, 'hooks', event), event));
  }
  return Object.freeze({
    repository_root: root,
    repository_hooks: repositoryHooks,
    template_root: globalTemplate,
    hooks: Object.freeze(installed),
  });
}

async function cruiseManifest(root) {
  const manifestPath = join(root, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.name !== 'cruise') {
    throw new Error(`${root} is not the Cruise plugin source`);
  }
  return Object.freeze({ manifest, manifestPath });
}

export async function ensurePersonalMarketplaceSource({
  repositoryRoot,
  home = homedir(),
} = {}) {
  const root = await realpath(resolve(repositoryRoot));
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
  const entry = marketplace.plugins?.find(({ name }) => name === 'cruise');
  if (
    typeof marketplace.name !== 'string'
    || !entry
    || entry.source?.source !== 'local'
    || entry.source?.path !== './plugins/cruise'
  ) {
    throw new Error(
      `${marketplacePath} must contain the standard local Cruise marketplace entry before automatic updates can run`,
    );
  }
  const sourcePath = join(home, 'plugins', 'cruise');
  await mkdir(dirname(sourcePath), { recursive: true });
  let metadata = null;
  try {
    metadata = await lstat(sourcePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (metadata?.isSymbolicLink()) {
    const current = await realpath(sourcePath).catch(() => null);
    if (current !== root) {
      await unlink(sourcePath);
      await symlink(root, sourcePath, 'dir');
    }
  } else if (metadata) {
    const current = await realpath(sourcePath);
    if (current !== root) {
      throw new Error(`refusing to replace non-symlink marketplace source ${sourcePath}`);
    }
  } else {
    await symlink(root, sourcePath, 'dir');
  }
  return Object.freeze({
    marketplace: marketplace.name,
    marketplace_path: marketplacePath,
    source_path: sourcePath,
    repository_root: root,
  });
}

export function activeCruiseProcesses({ run = spawnSync, pid = process.pid } = {}) {
  const result = run('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/u);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((entry) => entry && entry.pid !== pid)
    .filter(({ command }) => (
      /(?:^|\s)(?:\S*\/)?cruise(?:\.mjs)?\s+doctor\s+[^\n]*--(?:deep|troubleshoot)(?:\s|$)/u.test(command)
      || /(?:^|\s)(?:\S*\/)?cruise(?:\.mjs)?\s+worker(?:\s|$)/u.test(command)
    ));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function waitForCruiseIdle({
  inspect = activeCruiseProcesses,
  intervalMs = 2_000,
  onWait = () => {},
} = {}) {
  let announced = false;
  for (;;) {
    const active = inspect();
    if (active.length === 0) return;
    if (!announced) {
      announced = true;
      onWait(active);
    }
    await delay(intervalMs);
  }
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function withGitUpdateLock(operation, {
  home = homedir(),
  intervalMs = 1_000,
} = {}) {
  const lockPath = join(home, '.cache', 'cruise', 'git-update.lock');
  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid })}\n`);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
      } catch {
        // A concurrent process may still be writing the owner record.
      }
      if (owner && !(await processAlive(owner.pid))) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await delay(intervalMs);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function commandSucceeded(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} exited ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return result;
}

function listInstalledPlugins({ cwd, env }) {
  const result = spawnSync('codex', ['plugin', 'list'], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'codex plugin list failed');
  return result.stdout;
}

function configuredPluginReadyTimeout(env) {
  const raw = env.CRUISE_PLUGIN_READY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_PLUGIN_READY_TIMEOUT_MS;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new Error('CRUISE_PLUGIN_READY_TIMEOUT_MS must be a positive safe integer.');
  }
  return Number(raw);
}

export async function waitForInstalledPluginReady({
  repositoryRoot,
  version,
  env = process.env,
  timeoutMs = configuredPluginReadyTimeout(env),
  intervalMs = 250,
  listPlugins = listInstalledPlugins,
  inspectCache = inspectPluginCache,
  sleep = delay,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('plugin readiness timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('plugin readiness intervalMs must be a positive safe integer');
  }
  const root = await realpath(resolve(repositoryRoot));
  const codexHome = env.CODEX_HOME || null;
  const cacheRoot = resolvePluginCacheRoot({ codexHome, version });
  const deadline = now() + timeoutMs;
  let lastDetail = 'plugin registry has not exposed the installed Cruise version';
  for (;;) {
    try {
      const plugins = listPlugins({ cwd: root, env });
      const installedMatch = plugins.match(
        /^cruise@agent-local\s+installed, enabled\s+(\S+)\s+/mu,
      );
      if (installedMatch?.[1] === version) {
        const inspection = await inspectCache({
          sourceRoot: root,
          cacheRoot,
          enforceInstalledIdentity: true,
          codexHome,
        });
        if (inspection.matches) {
          return Object.freeze({ version, cache_root: cacheRoot, digest: inspection.source.digest });
        }
        lastDetail = pluginDigestDetail(inspection);
      } else if (installedMatch) {
        lastDetail = `plugin registry still exposes ${installedMatch[1]}, expected ${version}`;
      }
    } catch (error) {
      lastDetail = error.message;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Cruise plugin did not become registry-and-digest ready within ${timeoutMs}ms: ${lastDetail}`,
      );
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

export async function runAutomaticGitUpdate({
  repositoryRoot,
  event,
  env = process.env,
  home = homedir(),
  run = commandSucceeded,
  listPlugins = listInstalledPlugins,
  waitForPlugin = waitForInstalledPluginReady,
  ensureMarketplace = ensurePersonalMarketplaceSource,
  waitForIdle = waitForCruiseIdle,
  lock = (operation) => withGitUpdateLock(operation, { home }),
  output = process.stderr,
} = {}) {
  assertEvent(event);
  if (env.CRUISE_AUTO_UPDATE_ACTIVE === '1') {
    return Object.freeze({ status: 'skipped', reason: 'recursive' });
  }
  const root = await realpath(resolve(repositoryRoot));
  const { manifest } = await cruiseManifest(root);
  await waitForIdle({
    onWait(active) {
      output.write(
        `Cruise update is waiting for ${active.length} active worker/Doctor process${active.length === 1 ? '' : 'es'} to finish.\n`,
      );
    },
  });
  return lock(async () => {
    await waitForIdle();
    const marketplace = await ensureMarketplace({ repositoryRoot: root, home });
    const commandEnv = { ...env, CRUISE_AUTO_UPDATE_ACTIVE: '1' };
    const common = { cwd: root, env: commandEnv, stdio: 'inherit' };
    const pluginList = listPlugins({ cwd: root, env: commandEnv });
    const installed = /^cruise@agent-local\s+installed, enabled\s+/mu.test(pluginList);
    if (installed) run('codex', ['plugin', 'remove', 'cruise@agent-local'], common);
    run('codex', ['plugin', 'add', `cruise@${marketplace.marketplace}`], common);
    await waitForPlugin({
      repositoryRoot: root,
      version: manifest.version,
      env: commandEnv,
      listPlugins,
    });
    const entrypoint = join(root, 'scripts', 'cruise.mjs');
    run(process.execPath, [entrypoint, 'agents', 'install'], common);
    const doctorArgs = [entrypoint, 'doctor', '--deep', '--install-worker-rule'];
    run(process.execPath, doctorArgs, common);
    return Object.freeze({
      status: 'complete',
      event,
      version: manifest.version,
      marketplace: marketplace.marketplace,
      repository_root: root,
    });
  });
}
