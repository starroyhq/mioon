import {startServer} from './index.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const service = await startServer({
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
  try { await service.close(); } catch (error) { console.error('Shutdown failed:', error.code || error.name); process.exitCode = 1; }
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
