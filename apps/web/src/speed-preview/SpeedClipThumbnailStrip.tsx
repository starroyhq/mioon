/** Shared-time-map timeline thumbnail strip for speed & freeze clips (SP-V).
 *
 * Uses ONLY the existing project asset URL + shared time-map source frames
 * (zero new backend thumbnail endpoints). Serializes offscreen `<video>` frame
 * extraction through a single shared queue (concurrency = 1) so many clips on
 * the timeline never saturate the browser's 6-connection-per-origin HTTP/1.1
 * pool or starve main preview playback / RPCs.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {assetUrl} from '../api.ts';
import {disposeMedia} from '../Nodes.tsx';
import {useWorkspaceVisibility} from '../workspace-visibility.tsx';
import type {SpeedAssetLike, SpeedClipLike} from '../speed-ui/speed-model.ts';
import {computeClipThumbnailSamples, type ClipThumbnailSample} from './speed-preview-model.ts';

const FRAME_CACHE_MAX = 160;
const frameCache = new Map<string, string>();

function cacheFrame(key: string, dataUrl: string): void {
  if (frameCache.has(key)) frameCache.delete(key);
  frameCache.set(key, dataUrl);
  while (frameCache.size > FRAME_CACHE_MAX) {
    const oldest = frameCache.keys().next().value;
    if (oldest !== undefined) frameCache.delete(oldest);
  }
}

function seekVideoOnce(video: HTMLVideoElement, seconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const clamped = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, Math.min(seconds, Math.max(0, video.duration - 0.001)))
      : Math.max(0, seconds);
    if (!video.seeking && Math.abs(video.currentTime - clamped) < 0.005 && video.readyState >= 2) {
      resolve(true);
      return;
    }
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onSeeked = () => { cleanup(); resolve(!signal.aborted); };
    const onError = () => { cleanup(); resolve(false); };
    const onAbort = () => { cleanup(); resolve(false); };
    video.addEventListener('seeked', onSeeked, {once: true});
    video.addEventListener('error', onError, {once: true});
    signal.addEventListener('abort', onAbort, {once: true});
    try {
      video.currentTime = clamped;
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

function waitVideoMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    if (video.readyState >= 1) { resolve(true); return; }
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onReady = () => { cleanup(); resolve(!signal.aborted); };
    const onError = () => { cleanup(); resolve(false); };
    const onAbort = () => { cleanup(); resolve(false); };
    video.addEventListener('loadeddata', onReady, {once: true});
    video.addEventListener('loadedmetadata', onReady, {once: true});
    video.addEventListener('error', onError, {once: true});
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

interface ThumbnailJob {
  readonly url: string;
  readonly assetSig: string;
  readonly frames: readonly ClipThumbnailSample[];
  readonly signal: AbortSignal;
  readonly onFrame: (sourceFrame: number, dataUrl: string) => void;
}

const jobQueue: ThumbnailJob[] = [];
let queueRunning = false;

async function drainThumbnailQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  let sharedVideo: HTMLVideoElement | null = null;
  let sharedUrl = '';
  let sharedReady = false;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  try {
    while (jobQueue.length > 0) {
      const job = jobQueue.shift()!;
      if (job.signal.aborted) continue;

      const missing = job.frames.filter(frame => !frameCache.has(`${job.assetSig}:${frame.sourceFrame}`));
      if (!missing.length) continue;

      if (!sharedVideo || sharedUrl !== job.url) {
        if (sharedVideo) disposeMedia(sharedVideo);
        sharedVideo = document.createElement('video');
        sharedVideo.muted = true;
        sharedVideo.playsInline = true;
        sharedVideo.preload = 'auto';
        sharedVideo.crossOrigin = 'use-credentials';
        sharedVideo.src = job.url;
        sharedUrl = job.url;
        sharedReady = await waitVideoMetadata(sharedVideo, job.signal);
        if (!sharedReady) {
          disposeMedia(sharedVideo);
          sharedVideo = null;
          sharedUrl = '';
          continue;
        }
        const vw = sharedVideo.videoWidth || 160;
        const vh = sharedVideo.videoHeight || 90;
        const targetH = 44;
        const targetW = Math.max(24, Math.min(120, Math.round((vw / vh) * targetH)));
        canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        ctx = canvas.getContext('2d');
      }

      if (!sharedVideo || !canvas || !ctx) continue;

      for (const frame of missing) {
        if (job.signal.aborted) break;
        const cacheKey = `${job.assetSig}:${frame.sourceFrame}`;
        const cached = frameCache.get(cacheKey);
        if (cached) {
          job.onFrame(frame.sourceFrame, cached);
          continue;
        }
        const ok = await seekVideoOnce(sharedVideo, frame.seekSeconds, job.signal);
        if (!ok || job.signal.aborted) break;
        try {
          ctx.drawImage(sharedVideo, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
          cacheFrame(cacheKey, dataUrl);
          job.onFrame(frame.sourceFrame, dataUrl);
        } catch {
          break;
        }
      }
    }
  } finally {
    if (sharedVideo) disposeMedia(sharedVideo);
    queueRunning = false;
    if (jobQueue.length > 0) void drainThumbnailQueue();
  }
}

function enqueueThumbnailJob(job: ThumbnailJob): void {
  jobQueue.push(job);
  void drainThumbnailQueue();
}

export interface SpeedClipThumbnailStripProps {
  readonly clip: SpeedClipLike;
  readonly asset: SpeedAssetLike & {readonly id?: string; readonly projectId?: string; readonly sha256?: string; readonly url?: string};
  readonly fps: number;
  readonly widthPx: number;
}

export default function SpeedClipThumbnailStrip({clip, asset, fps, widthPx}: SpeedClipThumbnailStripProps): React.ReactElement | null {
  const visible = useWorkspaceVisibility();
  const url = assetUrl(asset as never);
  const samples = useMemo(
    () => computeClipThumbnailSamples(clip, fps, widthPx),
    [clip, fps, widthPx],
  );
  const sourceFramesAttr = useMemo(
    () => samples.map(sample => sample.sourceFrame).join(','),
    [samples],
  );
  const assetSig = `${asset.id ?? ''}:${asset.sha256 ?? ''}:${url}`;
  const [tiles, setTiles] = useState<readonly (string | null)[]>(() =>
    samples.map(sample => frameCache.get(`${assetSig}:${sample.sourceFrame}`) ?? null),
  );

  useEffect(() => {
    if (!url || !visible || !samples.length) return;
    const initialTiles = samples.map(sample => frameCache.get(`${assetSig}:${sample.sourceFrame}`) ?? null);
    setTiles(initialTiles);
    if (initialTiles.every(Boolean)) return;

    const ac = new AbortController();
    enqueueThumbnailJob({
      url,
      assetSig,
      frames: samples,
      signal: ac.signal,
      onFrame: (sourceFrame, dataUrl) => {
        if (ac.signal.aborted) return;
        setTiles(prev => {
          let changed = false;
          const next = samples.map((sample, index) => {
            if (sample.sourceFrame === sourceFrame) {
              if (prev[index] !== dataUrl) changed = true;
              return dataUrl;
            }
            return prev[index] ?? frameCache.get(`${assetSig}:${sample.sourceFrame}`) ?? null;
          });
          return changed ? next : prev;
        });
      },
    });

    return () => {
      ac.abort();
      const idx = jobQueue.findIndex(item => item.signal === ac.signal);
      if (idx >= 0) jobQueue.splice(idx, 1);
    };
  }, [assetSig, url, visible, sourceFramesAttr]);

  if (!url) return null;

  return (
    <span
      className="clip-speed-thumbnail-strip"
      data-testid={`clip-speed-thumbnails-${clip.id}`}
      data-source-frames={sourceFramesAttr}
      aria-hidden="true"
    >
      {samples.map((sample, index) => (
        tiles[index] ? (
          <img
            key={`${sample.slotIndex}-${sample.sourceFrame}`}
            src={tiles[index]!}
            alt=""
            className="clip-speed-thumbnail-tile"
            draggable={false}
          />
        ) : (
          <span key={`${sample.slotIndex}-${sample.sourceFrame}`} className="clip-speed-thumbnail-tile is-empty" />
        )
      ))}
    </span>
  );
}
