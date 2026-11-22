/** Starts a test-owned local backend that binds its own ephemeral port.
 *
 * Tests must never reserve a port by opening and closing a listener and then
 * hand that number to a child: another test file sharing the shard can claim the
 * freed port in between, so the child's `/health` check talks to a foreign
 * server and authenticated requests answer 401. The backend instead binds
 * `PORT=0`, prints the URL it actually bound, and gets an authenticated probe
 * with the caller's own token before this helper returns.
 */
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {testEnv} from './test-env.ts';

export interface OwnedServer {
  readonly child: ChildProcess;
  readonly url: string;
  readonly port: number;
  readonly tokenFile: string;
  stdout(): string;
  stderr(): string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface StartOwnedServerOptions {
  readonly repo: string;
  /** Private data directory of this fixture; also the identity of the child. */
  readonly root: string;
  /** Token only this child accepts; proves the reported URL is the own child. */
  readonly token: string;
  /** Script and its argv, for example `['server/index.ts']` or
   * `['tests/fixtures/project-server-process.ts', '--legacy-project-format']`. */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly ipc?: boolean;
  readonly timeoutMs?: number;
}

const readyLine = /^Mioon ready at (http:\/\/127\.0\.0\.1:(\d+)); local token file: (.+)$/mu;

export async function startOwnedServer({repo, root, token, args = ['server/index.ts'], env = {}, ipc = false, timeoutMs = 20_000}: StartOwnedServerOptions): Promise<OwnedServer> {
  const child = spawn(process.execPath, [...args], {
    cwd: repo,
    env: {...testEnv(), ...env, PORT: '0', MIOON_DATA_DIR: root, MIOON_TOKEN: token},
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {stdout += chunk;});
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {stderr += chunk;});
  const exited = once(child, 'exit');
  let stopping: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    await exited;
    if (child.connected) child.disconnect();
  })();
  try {
    const deadline = Date.now() + timeoutMs;
    let ready: {url: string; port: number; tokenFile: string} | undefined;
    while (Date.now() < deadline) {
      const match = readyLine.exec(stdout);
      if (match) {ready = {url: match[1]!, port: Number(match[2]!), tokenFile: match[3]!.trim()}; break;}
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned server exited before reporting its port: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error(`Owned server did not report its port: ${stderr}`);
    // The health endpoint answers for any server; the authenticated probe only
    // succeeds on the child that received this fixture's token.
    const health = await fetch(ready.url + '/health', {signal: AbortSignal.timeout(5_000)}).catch(() => undefined);
    const body = health ? await health.json().catch(() => undefined) as {service?: unknown} | undefined : undefined;
    if (health?.status !== 200 || body?.service !== 'mioon') throw new Error(`Owned server health check failed: ${stderr}`);
    const probe = await fetch(ready.url + '/api/ui-preferences', {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(5_000)}).catch(() => undefined);
    if (probe?.status !== 200) throw new Error(`Owned server did not accept this fixture's token: ${probe?.status ?? 'no response'} ${stderr}`);
    return {child, url: ready.url, port: ready.port, tokenFile: ready.tokenFile, stdout: () => stdout, stderr: () => stderr, stop};
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
