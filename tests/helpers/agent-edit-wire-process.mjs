/** A disposable full backend. Only this fixture's IPC may arm crash hooks;
 * no production HTTP/environment switch or provider credential is involved. */
import path from 'node:path';
import {appendFileSync} from 'node:fs';
let server, settings, root, armed, acquisitions = 0, closing, starting;
const phases = [];
const report = message => {
  if (process.connected) process.send(message, error => {
    // The parent may disappear after connected was checked. A failed report
    // still owns the resources already acquired by the pending startup.
    if (error) close().catch(() => {process.exitCode = 1;});
  });
};
const startupPhase = phase => report({type: 'startup-phase', phase});
const close = () => closing ??= (async () => {
  await starting?.catch(() => {});
  await server?.close(); await settings?.close();
  if (process.connected) process.disconnect();
})();
const active = () => !closing && process.connected;
const start = async message => {
  root = message.dataDir;
  startupPhase('module-loading');
  const [{startServer}, {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE}, {createAgentSettingsFile}] = await Promise.all([
    import('../../apps/server/src/index.mjs'), import('../../packages/business/src/agent/settings.mjs'), import('../../packages/business/src/agent/settings-file.mjs'),
  ]);
  startupPhase('module-loaded');
  if (!active()) return;
  settings = await createAgentSettings({persistence: createAgentSettingsFile({directory: path.join(root, 'agent-settings')})});
  startupPhase('settings-ready');
  if (!active()) return;
  const observed = {get: (...args) => settings.get(...args), put: (...args) => settings.put(...args),
    [AGENT_CREDENTIAL_ACQUIRE](...args) { acquisitions++; return settings[AGENT_CREDENTIAL_ACQUIRE](...args); }};
  const agentEditFault = label => {
    phases.push(label); appendFileSync(path.join(root, 'edit-fault-trace.jsonl'), JSON.stringify({label, crash: armed === label}) + '\n');
    if (armed === label) process.kill(process.pid, 'SIGKILL');
  };
  startupPhase('server-starting');
  server = await startServer({dataDir: root, port: 0, token: message.token, agentSettings: observed, agentEditFault});
  startupPhase('server-ready');
  if (active()) report({type: 'ready', pid: process.pid, url: server.url});
};
process.on('message', async message => {
  try {
    if (message.type === 'start' && !starting && active()) {
      startupPhase('start-received');
      starting = start(message); await starting;
    } else if (message.type === 'observe') report({type: 'reply', requestId: message.requestId, data: {acquisitions, phases}});
    else if (message.type === 'arm') { armed = message.boundary; report({type: 'reply', requestId: message.requestId, data: {armed}}); }
    else if (message.type === 'close') await close();
  } catch (error) { report({type: 'error', message: error.stack || String(error)}); process.exitCode = 1; await close().catch(() => {}); }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
startupPhase('process-booted');
