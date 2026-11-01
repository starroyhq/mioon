// The real backend process of tests/integration.test.ts. It starts the server
// as apps/server/src/cli.ts does. For the test only, it also answers one IPC
// question on the server's own connection: the Mock provider's ledger for a
// request. While this process holds the project, the test cannot open a
// second connection. No production endpoint or environment variable is added.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../../apps/server/src/index.ts';
import type {InspectProject} from '../../apps/server/src/index.ts';
import {comfyModuleModeFromEnvironment} from '../../apps/server/src/comfy-module.ts';
import {createHeadlessAgentSecretCodec} from '../../apps/server/src/headless-agent-secret-codec.ts';
// @mioon/node-host is not linked at the repository root, so import its entry by path.
import {initializeNodePrivateStorage} from '../../packages/node-host/src/private-storage-bootstrap.ts';

interface FixtureMessage {type?: unknown; id?: unknown; projectId?: unknown; requestId?: unknown}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let inspect: InspectProject|undefined;
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
await initializeNodePrivateStorage();
const service = await startServer({
  agentSecretCodecFactory: createHeadlessAgentSecretCodec,
  comfyModule: comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE),
  dataDir: process.env.MIOON_DATA_DIR || path.join(root, 'data'),
  port: Number(process.env.PORT || 4318),
  distDir: process.env.MIOON_DIST_DIR || path.join(root, 'apps/web/dist'),
  token: process.env.MIOON_TOKEN,
  inspectProject: received => { inspect = received; },
});
process.on('message', (raw: unknown) => {
  const message = raw as FixtureMessage;
  if (typeof message?.id !== 'string') return;
  try {
    if (message.type !== 'ledger') throw Error('Unsupported integration fixture message');
    if (!inspect) throw Error('The server has not handed over its connection');
    const requestId = String(message.requestId);
    // Plain rows, as they cross the IPC channel.
    const data = inspect(String(message.projectId), db => ({
      submissions: db.prepare('SELECT * FROM mock_provider_submissions WHERE request_id=?').all(requestId).map(row => ({...row})),
      tasks: db.prepare('SELECT * FROM mock_provider_tasks WHERE request_id=?').all(requestId).map(row => ({...row})),
    }));
    report({type: 'reply', id: message.id, data});
  } catch (error) {
    const failure = error as {code?: unknown; message?: unknown} | null;
    report({type: 'reply', id: message.id, error: {code: failure?.code ?? 'FIXTURE_ERROR', message: String(failure?.message ?? error)}});
  }
});
console.log(`Mioon ready at ${service.url}; local token file: ${service.tokenFile}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await service.close(); } catch (error) { const fields = error as {code?: unknown; name?: unknown} | null; console.error('Shutdown failed:', fields?.code || fields?.name); process.exitCode = 1; }
  // An open IPC channel would keep this process alive after the server closes.
  if (process.connected) process.disconnect();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
process.once('disconnect', close);
