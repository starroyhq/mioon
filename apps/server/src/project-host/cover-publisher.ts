import {runStreaming} from '@mioon/business/media-runtime';
import {resolveProjectMediaFile} from '@mioon/business/project-media-storage';
import type {ProjectStore} from '@mioon/business/project-file/index';
import type {ProjectHostSummary} from './host.ts';
import {PROJECT_COVER_LIMITS, writeProjectCover, readProjectCoverCache} from './covers.ts';

/** Optional, bounded cache work owned by the already-open project. Rendering
 * failures leave a cache miss; they do not turn a project read into a media job.
 * The last failure is retained for trusted diagnostics and tests. */
export function createProjectCoverPublisher({store, summarize, signal, render = runStreaming}: {
  store: ProjectStore; summarize: () => ProjectHostSummary | null; signal: AbortSignal; render?: typeof runStreaming;
}) {
  let pending = false, active: Promise<void> | undefined, lastFailure: unknown;
  const refresh = (): void => {
    if (signal.aborted) return;
    pending = true;
    if (active) return;
    active = Promise.resolve().then(async () => {
      while (pending && !signal.aborted) {
        pending = false;
        try {
          const cover = summarize()?.summary?.cover;
          if (!cover) continue;
          const asset = store.get('assets', cover.assetId) as {projectId?: unknown; relativePath?: unknown; sha256?: unknown; mimeType?: unknown} | undefined;
          if (!asset || asset.projectId !== store.projectId || asset.mimeType !== cover.mimeType || typeof asset.relativePath !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) continue;
          if (readProjectCoverCache(store.cacheDir, {...cover, sourceSha256: asset.sha256}) !== null) continue;
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
          const current = summarize()?.summary?.cover;
          if (!current || current.assetId !== cover.assetId || current.mimeType !== cover.mimeType) continue;
          writeProjectCover({cacheDir: store.cacheDir, source: {...cover, sourceSha256}, jpeg: Buffer.concat(chunks)});
          lastFailure = undefined;
        } catch (error) { lastFailure = error; }
      }
    }).finally(() => {active = undefined; if (pending && !signal.aborted) refresh();});
  };
  return {refresh, isBusy: () => pending || active !== undefined,
    drain: async (): Promise<void> => {while (active) await active;}, lastFailure: () => lastFailure};
}
