/** Disposable backend crash harness. Only trusted fixture IPC can arm a phase;
 * production HTTP and environment variables cannot configure task faults. */
import {startServer} from '../../apps/server/src/index.ts';

interface HttpHarnessServerLike {url: string; close(): Promise<unknown>}
interface HttpProcessMessage {type: string; dataDir?: string; token?: string; phase?: string; requestId?: string; [key: string]: unknown}
let server: HttpHarnessServerLike|undefined, armed: string|undefined, started = false, closing: Promise<void>|undefined;
const phases: string[] = [];
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
const close = () => closing ??= (async () => {
  await server?.close();
  if (process.connected) process.disconnect();
})();
process.on('message', async (raw: unknown) => {
  const message = raw as HttpProcessMessage;
  try {
    if (message.type === 'start' && !started) {
      started = true;
      server = await startServer({dataDir: String(message.dataDir), port: 0, token: message.token,
        taskFault(phase: string) {
          phases.push(phase);
          if (phase === armed) process.kill(process.pid, 'SIGKILL');
        }});
      report({type: 'ready', pid: process.pid, url: server.url});
    } else if (message.type === 'arm') {
      armed = message.phase;
      report({type: 'reply', requestId: message.requestId, data: {armed}});
    } else if (message.type === 'observe') report({type: 'reply', requestId: message.requestId, data: {phases}});
    else if (message.type === 'close') await close();
  } catch (error) {
    report({type: 'error', message: (error as {stack?: string}).stack || String(error)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
