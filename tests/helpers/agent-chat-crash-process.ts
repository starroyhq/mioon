// A real backend in a separately owned process. Only the settings-acquisition
// counter is instrumented; requests use the production HTTP protocol gateways.
import path from 'node:path';
import {startServer} from '../../apps/server/src/index.ts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../../packages/business/src/agent/settings.ts';
import {createAgentSettingsFile} from '../../packages/business/src/agent/settings-file.ts';

interface CrashServerLike {url: string; close(): Promise<unknown>}
type AgentSettingsLike = ReturnType<typeof createAgentSettings> extends Promise<infer T> ? T : never
interface CrashProcessMessage {type: string; dataDir?: string; token?: string; requestId?: string; [key: string]: unknown}
let server: CrashServerLike|undefined, settings: AgentSettingsLike|undefined, closing: Promise<void>|undefined, acquisitions = 0, started = false;
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
const close = () => closing ??= (async () => {
  await server?.close();
  await settings?.close();
  report({type: 'closed', acquisitions});
  if (process.connected) process.disconnect();
})();

process.on('message', async (raw: unknown) => {
  const message = raw as CrashProcessMessage;
  try {
    if (message.type === 'start' && !started) {
      started = true;
      settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(String(message.dataDir), 'agent-settings')})});
      const current = settings as unknown as Record<string|symbol,(...args: unknown[])=>unknown> & {close(): Promise<unknown>};
      const observedSettings = {
        get: (...args: unknown[]) => current.get!(...args),
        put: (...args: unknown[]) => current.put!(...args),
        close: () => current.close(),
        [AGENT_CREDENTIAL_ACQUIRE](...args: unknown[]) {
          acquisitions++;
          report({type: 'acquisition', acquisitions});
          return current[AGENT_CREDENTIAL_ACQUIRE]!(...args);
        },
      };
      server = await startServer({dataDir: String(message.dataDir), port: 0, token: message.token, agentSettings: observedSettings as never});
      report({type: 'ready', url: server.url, pid: process.pid, acquisitions});
    } else if (message.type === 'observe') report({type: 'observed', requestId: message.requestId, acquisitions});
    else if (message.type === 'close') await close();
  } catch (error) {
    report({type: 'error', message: (error as {stack?: string}).stack || String(error)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
