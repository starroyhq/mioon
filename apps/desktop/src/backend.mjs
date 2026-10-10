import { startServer } from '@mioon/server';
import { DatabaseSync } from 'node:sqlite';
import { onMediaProcess } from '@mioon/business/media-processes';
import { createAgentSettingsClient } from './secret-broker.mjs';
import { createImageSecretClient } from './image-secret-broker.mjs';

if (!process.parentPort || !process.versions.electron) throw new Error('Backend must run in Electron utilityProcess');
if (Number(process.versions.node.split('.')[0]) < 24 || typeof DatabaseSync !== 'function') {
  throw new Error('Bundled Electron Node 24 with node:sqlite is required');
}

let server, starting = false, startFailed = false, closing = false, lastPing = Date.now();
let initialization;
const agentSettings = createAgentSettingsClient({ port: process.parentPort });
const imageSecretCodec = createImageSecretClient({ port: process.parentPort });
onMediaProcess(({ type, pid, kind }) => process.parentPort.postMessage({ type: 'media-process', event: type, pid, kind }));
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(lease);
  let exitCode = 0;
  try { await initialization; await server?.close(); if (startFailed) exitCode = 1; }
  catch { exitCode = 1; }
  try { agentSettings.close(); } catch { exitCode = 1; }
  try { imageSecretCodec.close(); } catch { exitCode = 1; }
  try {
    process.parentPort.postMessage(exitCode === 0 ? { type: 'stopped' } : {
      type: 'shutdown-failed', code: 'BACKEND_STOP_FAILED', message: '本地服务退出时未能完成正常清理。'
    });
  } catch { exitCode = 1; }
  // Never report successful shutdown from a finally block after close failed.
  // Fixed messages only: the underlying error may contain paths or credentials.
  process.exit(exitCode);
}
const lease = setInterval(() => { if (Date.now() - lastPing > 30000) void shutdown(); }, 5000);
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'ping') { lastPing = Date.now(); return; }
  if (data?.type === 'stop') { void shutdown(); return; }
  if (data?.type !== 'start' || starting || closing) return;
  starting = true;
  initialization = (async () => {
    try {
      // A missing/locked OS vault disables persistent Images writes; it never
      // turns them into plaintext writes or prevents unrelated editing startup.
      try { await imageSecretCodec.refreshStorage(); } catch { /* Fail-closed cached availability. */ }
      server = await startServer({ dataDir: data.dataDir, port: 0, distDir: data.distDir, token: data.token, agentSettings, imageSecretCodec });
      if (!closing) process.parentPort.postMessage({ type: 'ready', url: server.url,
        runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, pid: process.pid } });
    } catch (error) {
      startFailed = true;
      // No stack, token, provider key, raw body, or entire config in process messages.
      process.parentPort.postMessage({ type: 'failed', code: 'BACKEND_START_FAILED',
        message: '本地服务启动失败。请检查数据目录是否被其他进程占用，以及应用文件是否完整。' });
      clearInterval(lease);
      agentSettings.close();
      imageSecretCodec.close();
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  })();
});
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
