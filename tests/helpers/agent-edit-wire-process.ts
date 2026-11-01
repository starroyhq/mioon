/** A disposable full backend. Only this fixture's IPC may arm crash hooks;
 * no production HTTP/environment switch or provider credential is involved. */
import path from 'node:path';
interface WireServerLike {readonly url: string; close(): Promise<unknown>}
type AgentSettingsLike = Awaited<ReturnType<typeof import('../../packages/business/src/agent/settings.ts').createAgentSettings>>
interface WireProcessMessage {readonly type: string; readonly dataDir?: string; readonly token?: string; readonly requestId?: string; readonly boundary?: string}
let server: WireServerLike|undefined, settings: AgentSettingsLike|undefined, root: string|undefined, armed: string|undefined, acquisitions = 0, closing: Promise<unknown>|undefined, starting: Promise<unknown>|undefined;
const phases: string[] = [];
const report = (message: unknown): void => {
  if (process.connected) process.send?.(message, error => {
    // The parent may disappear after connected was checked. A failed report
    // still owns the resources already acquired by the pending startup.
    if (error) close().catch(() => {process.exitCode = 1;});
  });
};
const startupPhase = (phase: string): void => report({type: 'startup-phase', phase});
const close = (): Promise<unknown> => closing ??= (async () => {
  await starting?.catch(() => {});
  await server?.close(); await settings?.close();
  if (process.connected) process.disconnect();
})();
const active = (): boolean => !closing && Boolean(process.connected);
const start = async (message: WireProcessMessage): Promise<void> => {
  root = String(message.dataDir);
  startupPhase('module-loading');
  const [{startServer}, {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE}, {createAgentSettingsFile}] = await Promise.all([
    import('../../apps/server/src/index.ts'), import('../../packages/business/src/agent/settings.ts'), import('../../packages/business/src/agent/settings-file.ts'),
  ]);
  startupPhase('module-loaded');
  if (!active()) return;
  const dataRoot = root as string;
  settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(dataRoot, 'agent-settings')})});
  startupPhase('settings-ready');
  if (!active()) return;
  const current = settings as unknown as Record<string|symbol,(...args: unknown[])=>unknown> & {close(): Promise<unknown>};
  const observed = {get: (...args: unknown[]) => current.get!(...args), put: (...args: unknown[]) => current.put!(...args), close: () => current.close(),
    [AGENT_CREDENTIAL_ACQUIRE](...args: unknown[]) { acquisitions++; return current[AGENT_CREDENTIAL_ACQUIRE]!(...args); }};
  startupPhase('server-starting');
  server = await startServer({dataDir: dataRoot, port: 0, token: message.token, agentSettings: observed as never});
  startupPhase('server-ready');
  if (active()) report({type: 'ready', pid: process.pid, url: server.url});
};
process.on('message', async (raw: unknown) => {
  const message = raw as WireProcessMessage;
  try {
    if (message.type === 'start' && !starting && active()) {
      startupPhase('start-received');
      starting = start(message); await starting;
    } else if (message.type === 'observe') report({type: 'reply', requestId: message.requestId, data: {acquisitions, phases}});
    else if (message.type === 'arm') { armed = message.boundary; report({type: 'reply', requestId: message.requestId, data: {armed}}); }
    else if (message.type === 'close') await close();
  } catch (error) { report({type: 'error', message: (error as {stack?: string}).stack || String(error)}); process.exitCode = 1; await close().catch(() => {}); }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
startupPhase('process-booted');
