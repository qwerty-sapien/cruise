import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveCodexHome } from './agent-config.mjs';

const CONTROL_FILES = Object.freeze([
  'config.toml',
  'auth.json',
  '.codex-global-state.json',
  'installation_id',
]);

const CONTROL_DIRECTORIES = Object.freeze(['accounts', 'agents', 'rules']);
const EXTENSION_PROFILES = new Set(['inherit', 'worker', 'doctor-discovery']);

export const WORKER_HOST_PATH_LOST =
  'CRUISE_WORKER_HOST_PATH_LOST: the Doctor-attested worker path became unavailable. Preserve the incident and run cruise doctor --deep before starting another Cruise skill.';

export const WORKER_INFERENCE_STREAM_FAILED =
  'CRUISE_WORKER_INFERENCE_STREAM_FAILED: the Codex inference stream exhausted its retry budget after the Doctor-attested worker path launched successfully. Preserve the terminal report and stop this run; do not launch a duplicate worker. Only a later fresh user-requested run may retry after Codex service and network health are checked.';

async function exists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Give a child app-server a writable CODEX_HOME without losing the user's
 * active configuration or authenticated account. This is deliberately a
 * per-process snapshot: Codex may update config/account state while it runs,
 * and those writes must never escape a workspace sandbox into the real home.
 */
export function configuredMcpServerNames(config) {
  const names = new Set();
  for (const line of String(config ?? '').split(/\r?\n/u)) {
    const candidate = line.trim();
    if (!candidate || candidate.startsWith('#')) continue;
    const header = /^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*([A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+'))*\s*\]\s*(?:#.*)?$/u.exec(candidate);
    const dotted = /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*([A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+'))*\s*=/u.exec(candidate);
    if (header || dotted) {
      names.add((header ?? dotted)[1].replace(/^["']|["']$/gu, ''));
      continue;
    }
    if (/^(?:\[\[?\s*)?(?:["']mcp_servers["']|mcp_servers)(?:\s*[.\]=]|\s)/u.test(candidate)) {
      throw new Error(
        'worker isolation cannot safely disable an unsupported mcp_servers TOML declaration',
      );
    }
  }
  return Object.freeze([...names].sort());
}

export function appServerExtensionArgs(profile, mcpServerNames = []) {
  if (!EXTENSION_PROFILES.has(profile)) {
    throw new TypeError(`unknown app-server extension profile: ${profile}`);
  }
  const names = [...new Set(mcpServerNames)].sort();
  if (!names.every((name) => /^[A-Za-z0-9_-]+$/u.test(name))) {
    throw new TypeError('MCP server names must be safe Codex config identifiers');
  }
  // The temporary CODEX_HOME protects the user's real configuration from
  // child-process writes. It must not also become a feature-reduced Codex:
  // plugins, Apps, MCP servers, rules, and the host's native approval model
  // remain inherited for every Cruise profile.
  return Object.freeze([]);
}

export async function createIsolatedAppServerRuntime({
  codexHome = null,
  extensionProfile = 'inherit',
} = {}) {
  if (!EXTENSION_PROFILES.has(extensionProfile)) {
    throw new TypeError(`unknown app-server extension profile: ${extensionProfile}`);
  }
  const sourceHome = resolve(codexHome ?? resolveCodexHome());
  const runtimeHome = await mkdtemp(join(tmpdir(), 'cruise-app-server-'));
  try {
    await chmod(runtimeHome, 0o700);
    for (const name of CONTROL_FILES) {
      const source = join(sourceHome, name);
      if (!await exists(source)) continue;
      const target = join(runtimeHome, name);
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
    for (const name of CONTROL_DIRECTORIES) {
      const source = join(sourceHome, name);
      if (!await exists(source)) continue;
      await cp(source, join(runtimeHome, name), { recursive: true, force: false });
    }
  } catch (error) {
    await rm(runtimeHome, { recursive: true, force: true });
    throw error;
  }

  const extensionPolicy = Object.freeze({
    profile: extensionProfile,
    plugins: 'inherited',
    apps: 'inherited',
    mcp_servers: 'inherited',
    native_guardrails: 'inherited',
    disabled_mcp_servers: Object.freeze([]),
  });
  return Object.freeze({
    codexHome: runtimeHome,
    appServerArgs: appServerExtensionArgs(extensionProfile),
    extensionPolicy,
    spawnOptions: Object.freeze({
      env: Object.freeze({ ...process.env, CODEX_HOME: runtimeHome }),
    }),
    async dispose() {
      await rm(runtimeHome, { recursive: true, force: true });
    },
  });
}

/** Keep process diagnostics actionable without exposing arbitrary child stderr. */
export function appServerDiagnostic(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((value) => (
    /unknown configuration field|failed to initialize sqlite state runtime|operation not permitted/u.test(value)
  ));
  return line ? `app-server: ${line}` : null;
}

export function workerConnectionDiagnostic(error) {
  const message = String(error?.message ?? '');
  if (
    /app-server.*(?:disconnect|connection|closed|reset|refused|exit(?:ed)?|terminat(?:e|ed))|connection.*app-server/iu.test(message)
  ) {
    return WORKER_HOST_PATH_LOST;
  }
  if (
    /stream disconnected|response retries exhausted|responseTooManyFailedAttempts|error sending request[^\n]*(?:codex\/)?responses/iu.test(message)
  ) {
    return WORKER_INFERENCE_STREAM_FAILED;
  }
  return null;
}
