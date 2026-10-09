import { startServer } from '@video-workbench/server';
import { DatabaseSync } from 'node:sqlite';
import { onMediaProcess } from '@video-workbench/business/media-processes';

if (!process.parentPort || !process.versions.electron) throw new Error('Backend must run in Electron utilityProcess');
if (Number(process.versions.node.split('.')[0]) < 24 || typeof DatabaseSync !== 'function') {
  throw new Error('Bundled Electron Node 24 with node:sqlite is required');
}

let server, starting = false, closing = false, lastPing = Date.now();
let initialization;
onMediaProcess(({ type, pid, kind }) => process.parentPort.postMessage({ type: 'media-process', event: type, pid, kind }));
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(lease);
  try { await initialization; await server?.close(); }
  finally { process.parentPort.postMessage({ type: 'stopped' }); process.exit(0); }
}
const lease = setInterval(() => { if (Date.now() - lastPing > 30000) void shutdown(); }, 5000);
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'ping') { lastPing = Date.now(); return; }
  if (data?.type === 'stop') { void shutdown(); return; }
  if (data?.type !== 'start' || starting || closing) return;
  starting = true;
  initialization = (async () => {
    try {
      server = await startServer({ dataDir: data.dataDir, port: 0, distDir: data.distDir, token: data.token });
      process.parentPort.postMessage({ type: 'ready', url: server.url,
        runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, pid: process.pid } });
    } catch (error) {
      // No stack, token, provider key, raw body, or entire config in process messages.
      process.parentPort.postMessage({ type: 'failed', code: error.code || 'BACKEND_START_FAILED',
        message: '本地服务启动失败。请检查数据目录是否被其他进程占用，以及应用文件是否完整。' });
      clearInterval(lease);
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  })();
});
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
