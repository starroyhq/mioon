// A real backend in a separately owned process. Only the settings-acquisition
// counter is instrumented; requests use the production HTTP protocol gateways.
import path from 'node:path';
import {startServer} from '../../apps/server/src/index.ts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../../packages/business/src/agent/settings.ts';
import {createAgentSettingsFile} from '../../packages/business/src/agent/settings-file.ts';

let server, settings, closing, acquisitions = 0, started = false;
const report = message => { if (process.connected) process.send(message); };
const close = () => closing ??= (async () => {
  await server?.close();
  await settings?.close();
  report({type: 'closed', acquisitions});
  if (process.connected) process.disconnect();
})();

process.on('message', async message => {
  try {
    if (message.type === 'start' && !started) {
      started = true;
      settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(message.dataDir, 'agent-settings')})});
      const observedSettings = {
        get: (...args) => settings.get(...args),
        put: (...args) => settings.put(...args),
        [AGENT_CREDENTIAL_ACQUIRE](...args) {
          acquisitions++;
          report({type: 'acquisition', acquisitions});
          return settings[AGENT_CREDENTIAL_ACQUIRE](...args);
        },
      };
      server = await startServer({dataDir: message.dataDir, port: 0, token: message.token, agentSettings: observedSettings});
      report({type: 'ready', url: server.url, pid: process.pid, acquisitions});
    } else if (message.type === 'observe') report({type: 'observed', requestId: message.requestId, acquisitions});
    else if (message.type === 'close') await close();
  } catch (error) {
    report({type: 'error', message: error.stack || String(error)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
