import { AppServerClient } from '../../../scripts/lib/app-server-client.mjs';
import { writeFile } from 'node:fs/promises';
const client = new AppServerClient({ initializeTimeoutMs: 10000, inactivityTimeoutMs: 20000 });
const result = { pid: null, phase: 'initialize', accountAvailable: false, quotaAvailable: false, modelTurns: 0 };
let stderr = '';
client.on('stderr', chunk => { stderr = (stderr + String(chunk)).slice(-12000); });
let timer;
try {
  await Promise.race([(async () => {
    await client.start();
    result.pid = client.child?.pid;
    result.phase = 'account/read refreshToken=true';
    const account = await client.request('account/read', { refreshToken: true });
    result.accountAvailable = Boolean(account.account);
    result.authType = account.account?.type ?? null;
    result.phase = 'account/rateLimits/read';
    const quota = await client.request('account/rateLimits/read');
    result.quotaAvailable = Boolean(quota.rateLimits);
    result.phase = 'complete';
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('25 second auth-check deadline')), 25000); })]);
} catch (error) {
  result.error = String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1500);
  result.code = error.code ?? null;
} finally {
  clearTimeout(timer);
  result.pid ??= client.child?.pid;
  await client.stop();
  result.childExitCode = client.child?.exitCode ?? null;
  result.childSignal = client.child?.signalCode ?? null;
  result.revokedObserved = /refresh token was revoked|refresh_token_revoked/i.test(stderr);
  result.refreshReusedObserved = /refresh_token_reused/i.test(stderr);
}
await writeFile(process.argv[2] ?? '/private/tmp/cruise-revoked-auth-before.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
