/** A disposable full backend. Only this fixture's IPC may arm crash hooks;
 * no production HTTP/environment switch or provider credential is involved. */
import path from 'node:path';
import {appendFileSync} from 'node:fs';
import {startServer} from '../../apps/server/src/index.mjs';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from '../../packages/business/src/agent/settings.mjs';
import {createAgentSettingsFile} from '../../packages/business/src/agent/settings-file.mjs';
let server, settings, root, armed, acquisitions = 0, closing, started = false;
const phases = [];
const report = message => { if (process.connected) process.send(message); };
const close = () => closing ??= (async () => {
  await server?.close(); await settings?.close();
  if (process.connected) process.disconnect();
})();
process.on('message', async message => {
  try {
    if (message.type === 'start' && !started) {
      started = true; root = message.dataDir;
      settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(root, 'agent-settings')})});
      const observed = {get: (...args) => settings.get(...args), put: (...args) => settings.put(...args),
        [AGENT_CREDENTIAL_ACQUIRE](...args) { acquisitions++; return settings[AGENT_CREDENTIAL_ACQUIRE](...args); }};
      const agentEditFault = label => {
        phases.push(label); appendFileSync(path.join(root, 'edit-fault-trace.jsonl'), JSON.stringify({label, crash: armed === label}) + '\n');
        if (armed === label) process.kill(process.pid, 'SIGKILL');
      };
      server = await startServer({dataDir: root, port: 0, token: message.token, agentSettings: observed, agentEditFault});
      report({type: 'ready', pid: process.pid, url: server.url});
    } else if (message.type === 'observe') report({type: 'reply', requestId: message.requestId, data: {acquisitions, phases}});
    else if (message.type === 'arm') { armed = message.boundary; report({type: 'reply', requestId: message.requestId, data: {armed}}); }
    else if (message.type === 'close') await close();
  } catch (error) { report({type: 'error', message: error.stack || String(error)}); process.exitCode = 1; await close().catch(() => {}); }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
