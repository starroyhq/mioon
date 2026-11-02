import {runStreaming} from '@mioon/business/media-runtime';
import {resolveProjectMediaFile} from '@mioon/business/project-media-storage';
import type {ProjectStore} from '@mioon/business/project-file/index';
import type {ProjectSummary} from '../../../../packages/contracts/src/project-home.ts';
import {PROJECT_COVER_LIMITS, writeProjectCover, readProjectCoverCache} from './covers.ts';

/** Optional, bounded cache work owned by the already-open project. Rendering
 * failures leave a cache miss; they do not turn a project read into a media job.
 * The last failure is retained for trusted diagnostics and tests. */
export function createProjectCoverPublisher({store, readCover, signal, render = runStreaming, refreshDelayMs = 2000}: {
  store: ProjectStore; readCover: () => ProjectSummary['cover']; signal: AbortSignal; render?: typeof runStreaming; refreshDelayMs?: number;
}) {
  if(!Number.isSafeInteger(refreshDelayMs)||refreshDelayMs<0)throw new TypeError('Invalid cover refresh delay');
  let pending = false, active: Promise<void> | undefined, timer:ReturnType<typeof setTimeout>|undefined,lastFailure: unknown;
  const cancelTimer=():void=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
  const schedule=():void=>{if(timer!==undefined||active||signal.aborted)return;timer=setTimeout(()=>{timer=undefined;start();},refreshDelayMs);timer.unref();};
  const start = (): void => {
    if(active)return;
    if(signal.aborted){pending=false;return;}
    pending=false;
    active=Promise.resolve().then(async()=>{
        try {
          signal.throwIfAborted();
          const cover = readCover();
          if (!cover) return;
          const asset = store.get('assets', cover.assetId) as {projectId?: unknown; relativePath?: unknown; sha256?: unknown; mimeType?: unknown} | undefined;
          if (!asset || asset.projectId !== store.projectId || asset.mimeType !== cover.mimeType || typeof asset.relativePath !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) return;
          if (readProjectCoverCache(store.cacheDir, {...cover, sourceSha256: asset.sha256}) !== null) return;
          const relativePath = asset.relativePath, sourceSha256 = asset.sha256;
          const source = resolveProjectMediaFile(store, relativePath);
          const fence = (): void => {
            signal.throwIfAborted();
            const latest = store.get('assets', cover.assetId) as typeof asset;
            if (!latest || latest.projectId !== store.projectId || latest.relativePath !== relativePath || latest.sha256 !== sourceSha256 || latest.mimeType !== cover.mimeType) throw new Error('Project cover source changed');
            resolveProjectMediaFile(store, relativePath);
          };
          const chunks: Buffer[] = [];
          await render('ffmpeg', ['-v', 'error', '-nostdin', '-ss', '0', '-i', source.file, '-frames:v', '1',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
          {signal, timeout: 15_000, maxStdoutBytes: PROJECT_COVER_LIMITS.jpegBytes, beforeSpawn: fence, beforeEffect: fence, onStdout: chunk => {chunks.push(Buffer.from(chunk));}});
          fence();
          const current = readCover();
          if (!current || current.assetId !== cover.assetId || current.mimeType !== cover.mimeType) return;
          writeProjectCover({cacheDir: store.cacheDir, source: {assetId:cover.assetId,mimeType:cover.mimeType,sourceSha256}, jpeg: Buffer.concat(chunks)});
          lastFailure = undefined;
        } catch (error) { lastFailure = error; }
    }).finally(() => {active = undefined; if (pending && !signal.aborted) schedule();});
  };
  const refresh=():void=>{if(signal.aborted)return;pending=true;schedule();};
  signal.addEventListener('abort',()=>{cancelTimer();pending=false;},{once:true});
  // Queued refreshes can be cancelled before an exclusive close. Only an
  // admitted read/render must keep its live owner busy until drain confirms it.
  return {refresh, isBusy: () => pending || active !== undefined,isRendering:()=>active!==undefined,
    drain: async (): Promise<void> => {
      cancelTimer();
      while(pending||active){if(!active)start();if(active)await active;cancelTimer();}
    }, lastFailure: () => lastFailure};
}
