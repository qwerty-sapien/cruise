// Manual macOS diagnostic. Never imported or executed by the unit test suite.
// Uses existing native Codex authentication; never reads or copies auth files.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../../../scripts/lib/app-server-client.mjs';

const mode = process.argv[2] ?? 'network';
const output = process.argv[3];
const directory = await realpath(await mkdtemp(join(tmpdir(), 'cruise-routing-evidence-')));
const workspace = join(directory, 'branch1');
await mkdir(workspace);
const network = '(deny network*)\n(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (remote tcp "*:53"))\n';
const resolver = '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))\n';
const variants = mode === 'canonical'
  ? ['alias-resolver', 'canonical-resolver']
  : ['normal', 'restricted-empty', 'restricted-explicit', 'restricted-loopback', 'restricted-unix'];
const results = [];
try {
  if (mode === 'filesystem') {
    const sibling = join(directory, 'branch2');
    await mkdir(sibling);
    await writeFile(join(workspace, 'fixture.txt'), 'own fixture\n');
    await writeFile(join(sibling, 'fixture.txt'), 'sibling fixture\n');
    const policy = join(directory, 'filesystem.sb');
    await writeFile(policy, '(version 1)\n(allow default)\n' +
      `(deny file-read* (subpath "${directory}"))\n` +
      `(allow file-read* (subpath "${workspace}"))\n` +
      `(allow file-read-metadata (subpath "${directory}"))\n` +
      '(deny file-write* (subpath "/"))\n' +
      `(allow file-write* (subpath "${workspace}"))\n` +
      '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))\n' +
      network + resolver);
    for (const [label, target] of [['own', workspace], ['sibling', sibling]]) {
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, '/bin/cat', join(target, 'fixture.txt')], { encoding: 'utf8', timeout: 10000 });
      results.push({ label, exitCode: result.status, signal: result.signal,
        permissionDenied: /Operation not permitted|Permission denied/u.test(result.stderr ?? '') });
    }
    for (const [label, target] of [['own-write', workspace], ['sibling-write', sibling]]) {
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, '/usr/bin/touch', join(target, 'new.txt')], { encoding: 'utf8', timeout: 10000 });
      results.push({ label, exitCode: result.status, signal: result.signal,
        permissionDenied: /Operation not permitted|Permission denied/u.test(result.stderr ?? '') });
    }
  } else {
    for (const variant of variants) {
      const extra = variant === 'restricted-loopback'
        ? '(allow network-outbound (remote tcp "localhost:*"))\n'
        : variant === 'restricted-unix' ? '(allow network-outbound (remote unix-socket))\n'
          : variant === 'alias-resolver'
            ? '(allow network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))\n'
            : variant === 'canonical-resolver' ? resolver : '';
      const policy = join(directory, `${variant}.sb`);
      await writeFile(policy, '(version 1)\n(allow default)\n' + network + extra);
      const restricted = variant !== 'normal';
      const client = new AppServerClient({
        command: restricted ? '/usr/bin/sandbox-exec' : 'codex',
        args: restricted ? ['-f', policy, 'codex', 'app-server', '--stdio'] : ['app-server', '--stdio'],
        spawnOptions: { cwd: workspace }, initializeTimeoutMs: 10000, inactivityTimeoutMs: 20000,
      });
      const row = { variant, pid: null, phase: 'initialize', authenticated: null, started: false, modelTurns: 0 };
      let timer;
      try {
        await Promise.race([(async () => {
          await client.start();
          row.pid = client.child.pid;
          row.phase = 'model/list';
          const catalog = await client.request('model/list', { limit: 100 });
          row.catalogModels = catalog.data?.length ?? null;
          row.phase = 'account/read';
          const account = await client.request('account/read', { refreshToken: false });
          row.authenticated = Boolean(account.account);
          row.phase = 'account/rateLimits/read';
          const limits = await client.request('account/rateLimits/read');
          row.rateLimitsAvailable = Boolean(limits.rateLimits);
          row.phase = 'thread/start';
          const thread = await client.request('thread/start', {
            cwd: workspace, runtimeWorkspaceRoots: variant === 'restricted-explicit' ? [workspace] : [],
            model: 'gpt-5.6-sol', allowProviderModelFallback: false,
            approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write', serviceName: 'cruise_worker', ephemeral: true,
          });
          row.started = Boolean(thread.thread?.id);
          row.phase = 'complete';
        })(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('25 second diagnostic deadline')), 25000);
        })]);
      } catch (error) {
        row.error = String(error.message).slice(0, 500);
        row.code = error.code ?? null;
      } finally {
        clearTimeout(timer);
        row.pid ??= client.child?.pid ?? null;
        await client.stop();
        row.childExitCode = client.child?.exitCode ?? null;
        row.childSignal = client.child?.signalCode ?? null;
      }
      results.push(row);
    }
  }
  const serialized = JSON.stringify(results, null, 2) + '\n';
  if (output) await writeFile(output, serialized);
  process.stdout.write(serialized);
} finally {
  await rm(directory, { recursive: true, force: true });
}
