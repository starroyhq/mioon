// Disposable real HTTP backend. Only owned fixture IPC can arm a crash; no
// production endpoint, environment variable, provider, or live media is used.
import {installWireGuard} from '../helpers/inspection-wire-fixture.ts';

const guard = installWireGuard({auditPath: process.argv[2]});
const {startServer} = await import('../../apps/server/src/index.ts');
const crashPhases = new Set(['afterPreparePersist', 'afterClaim', 'afterBusinessCommit', 'afterOutcomePersist']);
interface DraftsServerLike {url: string; close(): Promise<unknown>}
interface DraftsProcessMessage {type: string; root?: string; token?: string; phase?: string; id?: string; [key: string]: unknown}
let server: DraftsServerLike|undefined, armed: string|undefined, started = false, closing: Promise<void>|undefined;
const phases: string[] = [];
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
const close = () => closing ??= (async () => {
  await server?.close();
  if (process.connected) process.disconnect();
})();
process.on('message', async (raw: unknown) => {
  const message = raw as DraftsProcessMessage;
  try {
    if (message.type === 'start' && !started) {
      started = true;
      server = await startServer({dataDir: String(message.root), token: message.token, port: 0,
        chatGateway: async function* () { guard.deny('model gateway'); },
        taskFault(phase: string) {
          if (phases.length < 64) phases.push(phase);
          if (phase === armed) process.kill(process.pid, 'SIGKILL');
        },
      });
      report({type: 'ready', pid: process.pid, url: server.url});
    } else if (message.type === 'arm') {
      if (typeof message.phase !== 'string' || !crashPhases.has(message.phase)) throw Error('Unsupported synthetic crash phase');
      armed = message.phase;
      report({type: 'reply', id: message.id, data: {armed}});
    } else if (message.type === 'observe') report({type: 'reply', id: message.id, data: {phases}});
    else if (message.type === 'close') await close();
    else throw Error('Unsupported synthetic fixture message');
  } catch (error) {
    report({type: 'fatal', message: String((error as {stack?: string})?.stack || error).slice(-8000)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
