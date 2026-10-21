import {startServer} from './index.ts';
import {comfyModuleModeFromEnvironment} from './comfy-module.ts';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeNodePrivateStorage} from '@mioon/node-host/private-storage-bootstrap';
import {createHeadlessAgentSecretCodec} from './headless-agent-secret-codec.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await initializeNodePrivateStorage();
const service = await startServer({
  agentSecretCodecFactory:createHeadlessAgentSecretCodec,
  comfyModule: comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE),
  dataDir: process.env.MIOON_DATA_DIR || path.join(root, 'data'),
  port: Number(process.env.PORT || 4318),
  distDir: process.env.MIOON_DIST_DIR || path.join(root, 'apps/web/dist'),
  token: process.env.MIOON_TOKEN,
});
console.log(`Mioon ready at ${service.url}; local token file: ${service.tokenFile}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await service.close(); } catch (error) { const fields = error as {code?: unknown; name?: unknown} | null; console.error('Shutdown failed:', fields?.code || fields?.name); process.exitCode = 1; }
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
