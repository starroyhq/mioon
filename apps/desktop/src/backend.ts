import { startServer } from '@mioon/server';
import {comfyModuleModeFromEnvironment} from '../../server/src/comfy-module.ts';
import { DatabaseSync } from 'node:sqlite';
import { onMediaProcess } from '@mioon/business/media-processes';
import type {MediaProcessEvent} from '@mioon/business/media-processes';
import { initializeSubtitleResources } from '@mioon/business/subtitle-resources';
import { createAgentSettingsClient } from './secret-broker.ts';
import { createImageSecretClient } from './image-secret-broker.ts';
import { createVideoSecretClient } from './video-secret-client.ts';
import { createNativeAudioPreviewAuthority } from '@mioon/business/native-audio-preview';
import type {NativeAudioPreviewAuthority} from '@mioon/business/native-audio-preview';
import {workspaceNativeUtilityRequestSchema} from '../../../packages/contracts/src/workspace-native.ts';
import {workspaceSettingsSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
import {createBackendLease, BACKEND_LEASE_TIMING} from './backend-lease.ts';

/** Fixed diagnostic categories only; never a native error message or path. */
type ExitDiagnosticReason = 'startup-failed' | 'unhandled-rejection' | 'uncaught-exception' | 'stop-requested'
  | 'lease-expired' | 'signal-term' | 'signal-int' | 'shutdown-failed';
interface BackendServer {
  readonly url: string;
  setBackupDirectory(directory:string):unknown|Promise<unknown>;
  close(): unknown | Promise<unknown>;
}

function reportExitDiagnostic(reason: ExitDiagnosticReason) {
  // The diagnostic channel accepts fixed categories only. Errors may contain
  // credentials, request data, media content, or user paths.
  try { process.parentPort?.postMessage({ type: 'exit-diagnostic', reason }); }
  catch { /* Diagnostics must never cause a second failure while exiting. */ }
}

if (!process.parentPort || !process.versions.electron) {
  reportExitDiagnostic('startup-failed');
  throw new Error('Backend must run in Electron utilityProcess');
}
if (Number(process.versions.node.split('.')[0]) < 24 || typeof DatabaseSync !== 'function') {
  reportExitDiagnostic('startup-failed');
  throw new Error('Bundled Electron Node 24 with node:sqlite is required');
}
process.on('uncaughtExceptionMonitor', (_error, origin) => {
  reportExitDiagnostic(origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception');
});

let server: BackendServer | undefined, starting = false, startFailed = false, closing = false;
let initialization: Promise<void> | undefined;
let nativeAudioPreview: NativeAudioPreviewAuthority | undefined;
const agentSettings = createAgentSettingsClient({ port: process.parentPort });
const imageSecretCodec = createImageSecretClient({ port: process.parentPort });
const videoSecretCodec = createVideoSecretClient({ port: process.parentPort });
onMediaProcess(({ type, pid, kind }: MediaProcessEvent) => process.parentPort!.postMessage({ type: 'media-process', event: type, pid, kind }));
async function shutdown(reason: ExitDiagnosticReason) {
  if (closing) return;
  closing = true;
  reportExitDiagnostic(reason);
  parentLease.close();
  clearInterval(lease);
  let exitCode = 0;
  try { await initialization; await server?.close(); if (startFailed) exitCode = 1; }
  catch { exitCode = 1; }
  try { agentSettings.close(); } catch { exitCode = 1; }
  try { imageSecretCodec.close(); } catch { exitCode = 1; }
  try { videoSecretCodec.close(); } catch { exitCode = 1; }
  if (exitCode !== 0) reportExitDiagnostic('shutdown-failed');
  try {
    process.parentPort!.postMessage(exitCode === 0 ? { type: 'stopped' } : {
      type: 'shutdown-failed', code: 'BACKEND_STOP_FAILED', message: '本地服务退出时未能完成正常清理。'
    });
  } catch { exitCode = 1; }
  // Never report successful shutdown from a finally block after close failed.
  // Fixed messages only: the underlying error may contain paths or credentials.
  process.exit(exitCode);
}
const parentLease = createBackendLease({now: () => performance.now(),
  probe: probeId => process.parentPort!.postMessage({type: 'lease-probe', probeId}),
  expire: () => { void shutdown('lease-expired'); }});
const lease = setInterval(() => parentLease.check(), BACKEND_LEASE_TIMING.checkIntervalMs);
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'ping') { parentLease.ping(); return; }
  if (data?.type === 'lease-probe-ack') {
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 2 &&
        Object.hasOwn(data, 'type') && Object.hasOwn(data, 'probeId') && Number.isSafeInteger(data.probeId) && data.probeId > 0) parentLease.acknowledge(data.probeId);
    return;
  }
  if (data?.type === 'stop') { void shutdown('stop-requested'); return; }
  if(data?.type==='workspace-native:setBackupDirectory') {
    const parsed=workspaceNativeUtilityRequestSchema.safeParse(data);
    if(!parsed.success||closing||!server)return;
    const owned=server,request=parsed.data;
    void Promise.resolve().then(()=>{if(closing||server!==owned)throw Error('Unavailable');return owned.setBackupDirectory(request.directory);}).then(value=>{
      if(!closing&&server===owned)process.parentPort!.postMessage({type:'workspace-native:reply',requestId:request.requestId,ok:true,settings:workspaceSettingsSchema.parse(value)});
    }).catch(()=>{if(!closing&&server===owned)process.parentPort!.postMessage({type:'workspace-native:reply',requestId:request.requestId,ok:false,code:'WORKSPACE_NATIVE_UNAVAILABLE'});});
    return;
  }
  if (data?.type === 'native-audio:reserve' || data?.type === 'native-audio:retire') {
    if (nativeAudioPreview && !closing) void nativeAudioPreview.command(data).then(
      reply => process.parentPort!.postMessage(reply), () => { /* No fabricated retirement acknowledgment. */ });
    return;
  }
  if (data?.type !== 'start' || starting || closing) return;
  starting = true;
  initialization = (async () => {
    try {
      // A missing/locked OS vault disables persistent Images writes; it never
      // turns them into plaintext writes or prevents unrelated editing startup.
      try { await imageSecretCodec.refreshStorage(); } catch { /* Fail-closed cached availability. */ }
      try { await videoSecretCodec.refreshStorage(); } catch { /* Session-only remains available. */ }
      initializeSubtitleResources(data.subtitleResourcesDir);
      // A desktop utility without the fixed public-key gate must never fall
      // back to the ordinary Web PCM lane because main wiring was incomplete.
      nativeAudioPreview = createNativeAudioPreviewAuthority(data.nativeAudioPreview);
      server = await startServer({ comfyModule: comfyModuleModeFromEnvironment(process.env.MIOON_COMFY_MODULE), dataDir: data.dataDir, port: 0, distDir: data.distDir, token: data.token, agentSettings, imageSecretCodec, videoSecretCodec, nativeAudioPreview, localDraftChannel: __MIOON_DESKTOP_CHANNEL__ });
      if (!closing) process.parentPort!.postMessage({ type: 'ready', url: server.url,
        runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, pid: process.pid } });
    } catch (error) {
      startFailed = true;
      reportExitDiagnostic('startup-failed');
      // No stack, token, provider key, raw body, or entire config in process messages.
      process.parentPort!.postMessage({ type: 'failed', code: 'BACKEND_START_FAILED',
        message: '本地服务启动失败。请检查数据目录是否被其他进程占用，以及应用文件是否完整。' });
      clearInterval(lease);
      parentLease.close();
      agentSettings.close();
      imageSecretCodec.close();
      videoSecretCodec.close();
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  })();
});
process.on('SIGTERM', () => void shutdown('signal-term'));
process.on('SIGINT', () => void shutdown('signal-int'));
