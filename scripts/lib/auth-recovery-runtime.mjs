import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AppServerClient, AppServerRpcError } from './app-server-client.mjs';
import { createAuthRecovery, createEpisodeLocks } from './auth-recovery.mjs';

const own = (value, key) => value && typeof value === 'object'
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

// Codex 0.169.0 account/rateLimits/read: only the trailing provider body is
// authoritative. Never search prose, nested JSON, or another RPC for a token.
function codexRevokedBody(error, provider, transport) {
  if (provider !== 'codex' || transport !== 'app-server'
    || !(error instanceof AppServerRpcError) || own(error, 'code') !== -32603
    || own(own(error, 'request'), 'method') !== 'account/rateLimits/read') return false;
  const message = own(error, 'message');
  if (typeof message !== 'string' || Buffer.byteLength(message) > 16_384) return false;
  const match = /\bbody:\s*(\{[\s\S]*\})\s*$/u.exec(message);
  if (!match || Buffer.byteLength(match[1]) > 8_192) return false;
  try { return JSON.parse(match[1])?.error?.code === 'token_revoked'; }
  catch { return false; }
}

export class AuthRecoveryBoundaryError extends Error {
  constructor(cause, recovery) {
    super('Authentication recovery requires handoff; the failed operation was not replayed.', { cause });
    this.code = 'CRUISE_AUTH_RECOVERY_PAUSE';
    this.exitCode = 6;
    this.authRecovery = recovery;
  }
}

/** One recovery attempt until the caller establishes a successful new episode.
 * Normalization precedes recovery; absence of effects is not proof of no effect.
 */
export function createCallerAuthRecovery({ runtime, profile = 'default', provider = 'codex',
  transport = 'app-server', interactive = false, signal } = {}) {
  let attempted = false;
  return {
    reset() { attempted = false; },
    async attempt(error, { preEffect = false, nativeApprovalDenied = false } = {}) {
      if (!runtime) return null;
      const scope = { provider, profile, transport };
      const evidence = runtime.normalize(error, scope);
      if (!evidence || nativeApprovalDenied || signal?.aborted) return null;
      let result = { status: 'paused', reason: 'recovery-already-attempted' };
      if (!attempted) {
        attempted = true;
        try { result = await runtime.recover({ ...scope, evidence, interactive, signal }); }
        catch { result = { status: 'paused', reason: 'recovery-failed' }; }
      }
      return { retry: result?.status === 'recovered' && preEffect === true && !signal?.aborted,
        error: new AuthRecoveryBoundaryError(error, result) };
    },
  };
}

// Only constructed from a native SDK error envelope at the captured CLI boundary.
export class ClaudeNativeAuthError extends Error {
  constructor(state) {
    super('Claude reported a confirmed credential failure.');
    this.credentialState = state;
  }
}

export function captureClaudeAuthFailure(envelope) {
  if (own(envelope, 'type') !== 'assistant' || own(envelope, 'error') !== 'authentication_failed') return null;
  const content = own(own(envelope, 'message'), 'content');
  if (!Array.isArray(content) || content.length !== 1 || own(content[0], 'type') !== 'text') return null;
  // Exact native messages documented in Claude Code's error reference. Do not
  // interpret generic authentication_failed, result text, stderr, or task prose.
  const message = own(content[0], 'text');
  if (message === 'Failed to authenticate: OAuth session expired and could not be refreshed') return new ClaudeNativeAuthError('expired');
  if (message === 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.') return new ClaudeNativeAuthError('revoked');
  return null;
}

/** Contracts are host-owned, version-pinned native schema mappings, never error,
 * model or task supplied. No prose inference, recursive search, status-code inference or
 * guessed provider schema. AppServerRpcError preserves native code and data.
 * Each contract is {provider, transport, path, expired?, revoked?}; transport is
 * 'app-server' or 'provider-response'. Call only at the trusted transport boundary.
 */
export function createNativeAuthNormalizer(contracts = []) {
  const mappings = contracts.map(({ provider, transport, path, expired, revoked }) => {
    if (typeof provider !== 'string' || !['app-server', 'provider-response'].includes(transport)
      || !Array.isArray(path) || !path.length || path.length > 4
      || path.some(key => !['code', 'data', 'error', 'type', 'credentialState', 'state'].includes(key))
      || [expired, revoked].every(v => v === undefined)
      || [expired, revoked].some(v => v !== undefined && (typeof v !== 'string' || !/^(?:[a-z][a-z0-9]*_)*(?:expired|revoked)$/.test(v)))) {
      throw new Error('invalid-native-auth-contract');
    }
    return Object.freeze({ provider, transport, path: [...path], expired, revoked });
  });
  return (error, { provider, profile, transport }) => {
    if (typeof profile !== 'string' || !profile) return null;
    if (provider === 'claude' && transport === 'claude-cli' && error instanceof ClaudeNativeAuthError
      && ['expired', 'revoked'].includes(own(error, 'credentialState'))) return Object.freeze({
      source: 'provider-auth', confirmed: true, category: 'credential', provider, profile,
      code: `credential_${error.credentialState}`, credentialState: error.credentialState,
    });
    if (transport === 'app-server' && !(error instanceof AppServerRpcError)) return null;
    if (codexRevokedBody(error, provider, transport)) return Object.freeze({
      source: 'provider-auth', confirmed: true, category: 'credential', provider,
      profile, code: 'credential_revoked', credentialState: 'revoked',
    });
    for (const mapping of mappings) {
      if (mapping.provider !== provider || mapping.transport !== transport) continue;
      let value = error;
      for (const key of mapping.path) {
        // Do not execute getters while interpreting an error.
        value = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
      }
      const state = typeof value === 'string' && value === mapping.expired ? 'expired'
        : typeof value === 'string' && value === mapping.revoked ? 'revoked' : null;
      if (state) return Object.freeze({ source: 'provider-auth', confirmed: true,
        category: 'credential', provider, profile, code: `credential_${state}`, credentialState: state });
    }
    return null;
  };
}

/** POSIX process groups are created by this adapter; never target an unrelated
 * PID. Detached groups retain inherited terminal I/O. Programs that daemonize
 * outside their group cannot be certified by this adapter; do not configure them.
 */
export function createRuntimeLauncher({ spawnFn = spawn, kill = process.kill.bind(process),
  platform = process.platform, signals = process, setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutMs = 120_000, graceMs = 250, cleanupMs = 1_000, profile = 'default',
  portalUrls = [], observe = () => {}, cwd, env,
} = {}) {
  if (![timeoutMs, graceMs, cleanupMs].every(v => Number.isFinite(v) && v > 0 && v <= 2_147_483_647)) throw new Error('invalid-runtime-limits');
  const urls = new Set(portalUrls.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid-trusted-portal');
    return url.href;
  }));
  function launch(command, args, context, capture = false) {
    if (context.profile !== profile || context.signal?.aborted) throw new Error('runtime-profile-or-signal-mismatch');
    if (platform === 'win32') throw new Error('process-group-adapter-unavailable');
    const child = spawnFn(command, args, { shell: false, detached: true,
      ...(cwd ? { cwd } : {}), ...(env ? { env } : {}),
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    const pid = child.pid;
    let closed = false, failed = false, output = '', overflow = false, stopPromise;
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const exists = () => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return !closed;
      try { kill(-pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
    };
    const send = signal => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      try { kill(-pid, signal); } catch { /* probe below determines success */ }
    };
    const wait = ms => new Promise(resolve => setTimer(resolve, ms));
    const stop = () => stopPromise ||= (async () => {
      if (exists()) { send('SIGTERM'); await wait(graceMs); }
      if (exists()) { send('SIGKILL'); await wait(cleanupMs); }
      const confirmed = closed && !exists();
      dispose();
      return confirmed;
    })();
    const cancel = () => { resolveResult({ exitCode: null }); void stop(); };
    const dispose = () => {
      clearTimer(timer);
      context.signal?.removeEventListener('abort', cancel);
      signals.removeListener('SIGINT', cancel);
      signals.removeListener('SIGTERM', cancel);
    };
    const timer = setTimer(cancel, timeoutMs);
    context.signal?.addEventListener('abort', cancel, { once: true });
    signals.on('SIGINT', cancel);
    signals.on('SIGTERM', cancel);
    child.stdout?.on('data', chunk => {
      if (overflow) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > 16_384) { output = ''; overflow = true; cancel(); }
    });
    child.once('error', () => { failed = true; resolveResult({ exitCode: null }); });
    child.once('close', code => {
      closed = true;
      let data;
      if (capture && !overflow) {
        try { const parsed = JSON.parse(output); if (typeof parsed.loggedIn === 'boolean'
          && ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(parsed.authMethod)) data = {
          loggedIn: parsed.loggedIn,
          authMethod: parsed.authMethod,
        }; } catch { /* unavailable */ }
      }
      output = '';
      resolveResult({ exitCode: failed ? null : code, ...(data ? { data } : {}) });
      if (!exists()) dispose();
    });
    try { observe(Object.freeze({ kind: 'auth-child', pid, processGroup: pid })); } catch { /* optional */ }
    if (context.signal?.aborted) cancel();
    return { result, stop, pid, processGroup: pid };
  }
  return {
    startCommand(action, context) {
      const key = JSON.stringify([action?.command, action?.args]);
      const allowed = context.provider === 'codex' ? [['codex', ['login']]]
        : context.provider === 'claude' ? [['claude', ['auth', 'login']], ['claude', ['auth', 'status', '--json']]] : [];
      if (!allowed.some(a => JSON.stringify(a) === key)) throw new Error('untrusted-login-action');
      return launch(action.command, [...action.args], context, action.args.includes('--json'));
    },
    startPortal(url, context) {
      if (!urls.has(url)) throw new Error('untrusted-portal');
      return launch(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], context);
    },
  };
}

/** Profile names are identities supplied by the host, not alternate auth homes.
 * request/verifyExternal must already be bound to that same account and profile.
 * No environment, auth file, configuration or credential mutation occurs here.
 */
export function createAuthRecoveryRuntime({ profile = 'default', trustedProviders = [],
  nativeContracts = [], request, verifyExternal, locks,
  lockDirectory = join(tmpdir(), `cruise-auth-recovery-${process.getuid?.() ?? 'user'}`),
  launcherOptions = {}, ...coordinatorOptions } = {}) {
  const normalize = createNativeAuthNormalizer(nativeContracts);
  const launcher = createRuntimeLauncher({ ...launcherOptions, profile,
    portalUrls: trustedProviders.map(p => p.credentialPortal) });
  const coordinator = createAuthRecovery({ ...coordinatorOptions, ...launcher,
    locks: locks ?? createEpisodeLocks({ directory: lockDirectory }), trustedProviders, verifyExternal,
    request: request && (async (method, params, context) => {
      try { return await request(method, params, context); }
      catch (error) { throw normalize(error, { ...context, transport: 'app-server' }) ?? error; }
    }),
  });
  return { normalize, recover(input) {
    if (input.profile !== profile) return Promise.resolve({ status: 'not-applicable', reason: 'runtime-profile-mismatch' });
    return coordinator.recover(input);
  } };
}

/** CLI activation. Hash only the configured home pathname, never its contents or
 * credential values. Independent cwd/session IDs must share the same login lock.
 * Each account probe uses a new supported app-server so login changes are visible.
 */
export function createCliAuthRecovery({ provider = 'codex', cwd, env = process.env,
  input = process.stdin, platform = process.platform, signals = process, previousAccount,
  clientFactory = options => new AppServerClient(options),
  runtimeFactory = createAuthRecoveryRuntime, launcherOptions = {}, ...options } = {}) {
  const home = provider === 'claude' ? env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    : env.CODEX_HOME || join(homedir(), '.codex');
  const profile = createHash('sha256').update(JSON.stringify([provider, resolve(cwd ?? process.cwd(), home)])).digest('hex');
  // Presence only: never inspect a credential value, and never replace an explicit
  // token/key or third-party billing route with an interactive subscription login.
  const externalCredential = (provider === 'claude'
    ? ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY']).some(key => Object.hasOwn(env, key));
  const clients = new Map();
  let cleanupFailed = false;
  // Caller-supplied previousAccount is trusted prior account/read metadata, never
  // credential-store data or a post-login guess. Missing identifying metadata
  // cannot prove account continuity, even when authentication/quota succeeds.
  const identityOf = account => account?.type === 'chatgpt' && typeof account.email === 'string' && account.email.length > 0
    ? JSON.stringify([account.type, account.email, account.planType ?? null]) : undefined;
  let accountIdentity = identityOf(previousAccount);
  let identityProbeStarted = false;
  const stop = (client) => {
    if (!clients.get(client)) clients.set(client, (async () => {
      try {
        const result = await client.stop({ timeoutMs: 200 });
        if (result?.error || result?.cause) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    })());
    return clients.get(client);
  };
  const runtime = runtimeFactory({ ...options, profile,
    confirmIdentity: () => Boolean(accountIdentity),
    launcherOptions: { ...launcherOptions, platform, signals, cwd, env },
    cleanupVerification: async () => {
      await Promise.all([...clients.keys()].map(stop));
      clients.clear();
      return !cleanupFailed;
    },
    request: async (method, params, { signal }) => {
      signal.throwIfAborted();
      // Only the first pre-login probe can establish a missing baseline. Latch
      // before awaiting: failed/null probes must not trust a new login identity,
      // including on later recovery attempts through this runtime.
      const captureIdentity = method === 'account/read' && !identityProbeStarted;
      if (method === 'account/read') identityProbeStarted = true;
      const client = clientFactory({ spawnOptions: { cwd, env },
        clientInfo: { name: 'cruise-auth-verifier', title: 'Cruise auth verification', version: '1' } });
      clients.set(client, null);
      const abort = () => { void stop(client); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.start();
        signal.throwIfAborted();
        let response;
        try { response = await client.request(method, params); }
        catch (error) {
          // Refresh failures have no supported expiry schema of their own. Ask
          // the exact known authority before deciding whether login is justified.
          if (method === 'account/read' && !signal.aborted) {
            try { await client.request('account/rateLimits/read'); }
            catch (authorityError) {
              if (codexRevokedBody(authorityError, 'codex', 'app-server')) throw authorityError;
            }
          }
          throw error;
        }
        if (method === 'account/read' && response?.account) {
          const account = response.account;
          const identity = identityOf(account);
          if (accountIdentity && accountIdentity !== identity) throw new Error('auth-account-changed');
          if (captureIdentity && !accountIdentity) accountIdentity = identity;
        }
        return response;
      } finally {
        signal.removeEventListener('abort', abort);
        await stop(client);
        if (cleanupFailed) throw new Error('auth-verifier-cleanup-unconfirmed');
      }
    },
  });
  return { profile, normalize: runtime.normalize,
    async recover(context) {
      if (externalCredential) return { status: 'paused', reason: 'configured-credential-update-required' };
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      signals.on('SIGINT', abort); signals.on('SIGTERM', abort);
      if (context.signal?.aborted) abort();
      try {
        return await runtime.recover({ ...context, signal: controller.signal,
          // stdin availability is separate from GUI/browser availability. A normal
          // macOS command can open supported sign-in without a terminal.
          interactive: context.interactive === true || input?.isTTY === true || platform === 'darwin' });
      } finally {
        controller.abort();
        context.signal?.removeEventListener('abort', abort);
        signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort);
      }
    },
  };
}
