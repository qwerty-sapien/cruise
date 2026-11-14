import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

const LOGIN = Object.freeze({
  codex: Object.freeze({ command: 'codex', args: Object.freeze(['login']) }),
  claude: Object.freeze({ command: 'claude', args: Object.freeze(['auth', 'login']) }),
});
const STATUS = Object.freeze({ command: 'claude', args: Object.freeze(['auth', 'status', '--json']) });
const STATES = Object.freeze({ credential_expired: 'expired', credential_revoked: 'revoked' });

/** Only trusted provider adapters may construct this normalized evidence.
 * Never pass model/task text, a generic HTTP status, or parsed error prose here.
 */
export function classifyAuthFailure(evidence, { provider, profile }) {
  if (!evidence || evidence.source !== 'provider-auth' || evidence.confirmed !== true
    || evidence.category !== 'credential' || evidence.provider !== provider
    || evidence.profile !== profile || !Object.hasOwn(STATES, evidence.code)
    || evidence.credentialState !== STATES[evidence.code]) return null;
  return evidence.credentialState;
}

function privateDirectory(path) {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe-lock-directory');
  return stat;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Local-host, cross-process lock. The parent must be trusted; root must be private.
 * A live PID is never evicted on age alone (PID reuse conservatively waits).
 * Unique owner filenames plus rmdir prevent a stale reaper deleting a successor.
 * Empty directories left by death during registration are recoverable after grace.
 */
export function createEpisodeLocks({ directory, isAlive = alive, now = Date.now, orphanMs = 1_000 } = {}) {
  if (typeof directory !== 'string' || !Number.isFinite(orphanMs) || orphanMs < 0) {
    throw new Error('invalid-lock-configuration');
  }
  const root = resolve(directory);
  try { fs.mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  privateDirectory(root);
  const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const removeEmpty = (path) => {
    try { fs.rmdirSync(path); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
  return {
    tryAcquire(provider, profile) {
      privateDirectory(root);
      const key = createHash('sha256').update(JSON.stringify([provider, profile])).digest('hex');
      const path = join(root, key);
      try { fs.mkdirSync(path, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stat;
        try { stat = privateDirectory(path); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        let entries;
        try { entries = fs.readdirSync(path); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        for (const entry of entries) {
          const match = /^owner-([1-9][0-9]*)-([a-f0-9-]{36})$/.exec(entry);
          if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('invalid-lock-owner');
          if (!isAlive(Number(match[1]))) {
            try { fs.unlinkSync(join(path, entry)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        if (entries.length || now() - stat.mtimeMs >= orphanMs) removeEmpty(path);
        return null;
      }
      const initial = privateDirectory(path);
      const marker = join(path, `owner-${process.pid}-${randomUUID()}`);
      try {
        fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
        if (!sameDirectory(initial, privateDirectory(path))) {
          fs.unlinkSync(marker);
          return null;
        }
      } catch (error) {
        try { fs.unlinkSync(marker); } catch { /* registration did not survive */ }
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      let released = false;
      return {
        release() {
          if (released) return;
          // Never unlink another owner's marker or recursively remove a lock.
          fs.unlinkSync(marker);
          removeEmpty(path);
          released = true;
        },
      };
    },
  };
}

function bounded(operation, signal, milliseconds) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const finish = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, new Error('cancelled'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(reject, new Error('timeout')), milliseconds);
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('cancelled');
      return operation();
    }).then(value => finish(resolvePromise, value), error => finish(reject, error));
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    const finish = (cancelled) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (cancelled) reject(new Error('cancelled')); else resolvePromise();
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function portals(configurations) {
  const result = new Map();
  for (const configuration of configurations) {
    const { id, credentialPortal } = configuration;
    const url = new URL(credentialPortal);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || Object.hasOwn(LOGIN, id) || result.has(id)
      || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid-trusted-provider');
    }
    result.set(id, url.href);
  }
  return result;
}

function validLimits(response) {
  const limits = response?.rateLimits;
  return Boolean(limits && [limits.primary, limits.secondary].some(window => window
    && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
    && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0
    && Number.isFinite(window.resetsAt)));
}

/** Dependency contract (no provider/browser/process is started by this module):
 * - locks.tryAcquire returns null or a synchronous release handle.
 * - startCommand synchronously returns { result: Promise<{exitCode,data?}>, stop }.
 *   It must launch without a shell, bind the requested profile, own the entire child
 *   tree, and make stop() resolve true ONLY after all owned processes have exited.
 *   Even naturally completed commands are stopped/reaped before releasing the lock.
 * - request and verifyExternal must honor signal; request is bound to this profile.
 * - trustedProviders is host-owned configuration, NEVER task/model/error input.
 * - observe receives allowlisted lifecycle fields, never provider output or errors.
 * Success proves authentication only; callers must independently reapply quota,
 * account/workspace routing, approval, integrity, and other original gates.
 */
export function createAuthRecovery({
  locks, startCommand, startPortal, request, verifyExternal, trustedProviders = [], observe = () => {},
  timeoutMs = 120_000, pollMs = 100, cleanupMs = 2_000, cleanupVerification = async () => true,
  confirmIdentity = () => true,
} = {}) {
  if (!locks?.tryAcquire || ![timeoutMs, pollMs, cleanupMs].every(n => Number.isFinite(n) && n > 0 && n <= 2_147_483_647)) {
    throw new Error('invalid-recovery-configuration');
  }
  const external = portals(trustedProviders);
  return {
    async recover({ provider, profile, evidence, signal, interactive = false } = {}) {
      const outcome = (status, reason, extra = {}) => Object.freeze({ status, reason, ...extra });
      if (typeof profile !== 'string' || !profile || profile.length > 1_024
        || !(Object.hasOwn(LOGIN, provider) || external.has(provider))
        || !classifyAuthFailure(evidence, { provider, profile })) {
        return outcome('not-applicable', 'no-confirmed-credential-failure');
      }
      if (signal?.aborted) return outcome('cancelled', 'cancelled');
      if (!interactive) return external.has(provider)
        ? outcome('paused', 'external-credential-update-required', { handoff: { kind: 'credential-portal', url: external.get(provider) } })
        : outcome('paused', 'interactive-login-required', { handoff: { kind: 'login', action: LOGIN[provider] } });
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const emit = (stage) => { try { observe(Object.freeze({ provider, stage })); } catch { /* telemetry is optional */ } };
      const run = (fn) => bounded(fn, controller.signal, timeoutMs);
      let lease;
      let cleanupFailed = false;
      let loginAllowed = true;
      const children = new Set();
      const command = async (action) => {
        if (controller.signal.aborted) throw new Error('cancelled');
        if (!startCommand) throw new Error('adapter-unavailable');
        // Register synchronously so cancellation cannot lose a late child handle.
        const child = startCommand(action, { provider, profile, signal: controller.signal });
        if (!child || typeof child.stop !== 'function' || !child.result?.then) {
          cleanupFailed = true;
          throw new Error('invalid-command-handle');
        }
        children.add(child);
        return run(() => child.result);
      };
      const verify = async () => {
        emit('verifying');
        try {
          if (provider === 'codex') {
            if (!request) return 'unavailable';
            const context = { provider, profile, signal: controller.signal };
            const account = await run(() => request('account/read', { refreshToken: true }, context));
            if (account?.account === null && typeof account.requiresOpenaiAuth === 'boolean') return 'invalid';
            if (!['chatgpt', 'apiKey'].includes(account?.account?.type)
              || typeof account.requiresOpenaiAuth !== 'boolean') return 'unavailable';
            loginAllowed = account.account.type === 'chatgpt';
            const limits = await run(() => request('account/rateLimits/read', undefined, context));
            if (!validLimits(limits)) return 'unavailable';
            return confirmIdentity() === true ? 'verified' : 'identity-unconfirmed';
          }
          if (provider === 'claude') {
            const status = await command(STATUS);
            loginAllowed = !status?.data?.authMethod || ['none', 'claude.ai'].includes(status.data.authMethod);
            if (!loginAllowed) return 'unavailable';
            if (status?.data?.loggedIn === false && [0, 1].includes(status.exitCode)) return 'invalid';
            return status?.exitCode === 0 && status?.data?.loggedIn === true ? 'verified' : 'unavailable';
          }
          if (!verifyExternal) return 'unavailable';
          const state = await run(() => verifyExternal({ provider, profile, signal: controller.signal }));
          if (state?.verified === true && state.updated === true) return 'verified';
          return state?.verified === false ? 'invalid' : 'unavailable';
        } catch (error) {
          if (controller.signal.aborted) throw error;
          return classifyAuthFailure(error, { provider, profile }) ? 'invalid' : 'unavailable';
        }
      };
      let result;
      try {
        emit('waiting');
        while (!lease) {
          if (controller.signal.aborted) throw new Error('cancelled');
          lease = locks.tryAcquire(provider, profile);
          if (!lease) await delay(pollMs, controller.signal);
        }
        emit('leader');
        const before = await verify();
        // Claude status describes local sign-in. It cannot disprove a captured
        // upstream rejection; perform login before considering fresh status.
        if (before === 'verified' && provider !== 'claude') result = outcome('recovered', 'already-verified');
        else if (external.has(provider)) {
          emit('handoff');
          if (startPortal) {
            const child = startPortal(external.get(provider), { provider, profile, signal: controller.signal });
            if (!child || typeof child.stop !== 'function' || !child.result?.then) {
              cleanupFailed = true;
              throw new Error('invalid-portal-handle');
            }
            children.add(child);
            await run(() => child.result);
          }
          result = outcome('paused', 'external-credential-update-required', { handoff: { kind: 'credential-portal', url: external.get(provider) } });
        } else if (!loginAllowed) result = outcome('paused', 'credential-update-required');
        else if (before === 'identity-unconfirmed') result = outcome('paused', 'owner-identity-confirmation-required');
        else if (before === 'unavailable') result = outcome('paused', 'verification-unavailable');
        else if (!interactive) result = outcome('paused', 'interactive-login-required', { handoff: { kind: 'login', action: LOGIN[provider] } });
        else {
          emit('login');
          const login = await command(LOGIN[provider]);
          if (login?.exitCode !== 0) result = outcome('failed', 'login-failed');
          else {
            const after = await verify();
            result = after === 'verified' ? outcome('recovered', 'verified-after-login')
              : outcome('paused', after === 'identity-unconfirmed' ? 'owner-identity-confirmation-required' : 'verification-required');
          }
        }
      } catch {
        result = controller.signal.aborted
          ? outcome(timedOut ? 'paused' : 'cancelled', timedOut ? 'timeout' : 'cancelled')
          : outcome('failed', 'recovery-failed');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        emit('cleanup');
        // All handles are task-owned. Never kill by command name, port, or profile.
        const stops = await Promise.allSettled([...children].map(child =>
          bounded(() => child.stop(), undefined, cleanupMs)));
        cleanupFailed ||= stops.some(stop => stop.status !== 'fulfilled' || stop.value !== true);
        // Only the lease owner can have started verification. A cancelled waiter
        // must not stop or erase a leader's clients in the shared runtime adapter.
        if (lease) {
          try { const verifiedCleanup = await bounded(cleanupVerification, undefined, cleanupMs); cleanupFailed ||= verifiedCleanup !== true; }
          catch { cleanupFailed = true; }
        }
        if (!cleanupFailed) {
          try { lease?.release(); } catch { cleanupFailed = true; }
        }
      }
      if (cleanupFailed) result = outcome('failed', 'cleanup-unconfirmed', { lockRetained: Boolean(lease) });
      emit(result.status);
      return result;
    },
  };
}
