/** Polling controller & React hook for `timeline.preview.media` (SP-V).
 *
 * Only active when `capabilities.speed === true` and a ready video clip is active
 * in the `source` preview tab. Polls every 2000 ms while proxy status is `queued`
 * or `running`, stops immediately once `ready` / `failed` / `native`, and fences
 * stale replies across rapid clip switching or timeline edits.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import type {SpeedProcessingItem} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {SpeedAssetLike, SpeedClipLike, SpeedTimelineLike} from '../speed-ui/speed-model.ts';
import {
  SPEED_PROCESSING_MAX_CONSECUTIVE_FAILURES,
  SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS,
  isRetryableProcessingPollError,
  speedProcessingBackoffDelayMs,
} from '../speed-ui/use-speed-processing.ts';
import type {SpeedProcessingPollState} from '../speed-ui/use-speed-processing.ts';
import {
  clipNeedsPreviewMediaRpc,
  parsePreviewMediaForClip,
  previewMediaNeedsPolling,
} from './speed-preview-model.ts';
import type {PreviewMedia} from './speed-preview-model.ts';

export const SPEED_PREVIEW_POLL_INTERVAL_MS = 2000;

export type SpeedPreviewMediaRpc = (
  operation: string,
  input: unknown,
  options?: {readonly signal?: AbortSignal},
) => Promise<unknown>;

export interface SpeedPreviewMediaController {
  start(): void;
  refresh(): void;
  stop(): void;
  dispose(): void;
  getState(): SpeedProcessingPollState;
}

export function createSpeedPreviewMediaController(options: {
  readonly projectId: string;
  readonly clipId: string;
  readonly read: (signal: AbortSignal) => Promise<unknown>;
  readonly onMedia: (media: PreviewMedia | null) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): SpeedPreviewMediaController {
  const intervalMs = options.intervalMs ?? SPEED_PREVIEW_POLL_INTERVAL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS;
  const maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? SPEED_PROCESSING_MAX_CONSECUTIVE_FAILURES);
  const schedule = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelTimer = options.clearTimeoutFn ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let running = false;
  let disposed = false;
  let seq = 0;
  let consecutiveFailures = 0;
  let state: SpeedProcessingPollState = 'idle';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  function setState(next: SpeedProcessingPollState, error?: unknown): void {
    if (state === next && error === undefined) return;
    state = next;
    options.onStateChange?.(next, error);
  }

  function clearPending(): void {
    if (timer !== null) {
      cancelTimer(timer);
      timer = null;
    }
    if (abortController !== null) {
      abortController.abort();
      abortController = null;
    }
  }

  function handlePollFailure(error: unknown): void {
    if (disposed || !running) return;
    if (!isRetryableProcessingPollError(error)) {
      running = false;
      consecutiveFailures = 0;
      setState('failed', error);
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      running = false;
      setState('unknown', error);
      return;
    }
    setState('retrying', error);
    const delayMs = speedProcessingBackoffDelayMs(consecutiveFailures, intervalMs, maxBackoffMs);
    timer = schedule(() => {
      timer = null;
      fetchOnce();
    }, delayMs);
  }

  function fetchOnce(): void {
    if (disposed || !running) return;
    clearPending();
    const requestSeq = ++seq;
    const ac = new AbortController();
    abortController = ac;
    let requestPromise: Promise<unknown>;
    try {
      requestPromise = Promise.resolve(options.read(ac.signal));
    } catch (syncError) {
      requestPromise = Promise.reject(syncError);
    }
    void requestPromise
      .then(
        response => {
          if (disposed || !running || requestSeq !== seq || ac.signal.aborted) return;
          const media = parsePreviewMediaForClip(response, options.projectId, options.clipId);
          if (media === null) {
            handlePollFailure(new Error('INVALID_PREVIEW_MEDIA_RESPONSE'));
            return;
          }
          consecutiveFailures = 0;
          options.onMedia(media);
          if (previewMediaNeedsPolling(media)) {
            setState('polling');
            timer = schedule(() => {
              timer = null;
              fetchOnce();
            }, intervalMs);
          } else {
            running = false;
            setState('idle');
          }
        },
        error => {
          if (disposed || !running || requestSeq !== seq || ac.signal.aborted) return;
          handlePollFailure(error);
        },
      )
      .finally(() => {
        if (abortController === ac) abortController = null;
      });
  }

  return {
    start() {
      if (disposed) return;
      consecutiveFailures = 0;
      running = true;
      setState('polling');
      fetchOnce();
    },
    refresh() {
      if (disposed) return;
      consecutiveFailures = 0;
      running = true;
      setState('polling');
      fetchOnce();
    },
    stop() {
      running = false;
      consecutiveFailures = 0;
      seq += 1;
      clearPending();
      setState('idle');
    },
    dispose() {
      running = false;
      consecutiveFailures = 0;
      seq += 1;
      clearPending();
      setState('idle');
      disposed = true;
    },
    getState: () => state,
  };
}

export interface UseSpeedPreviewMediaResult {
  readonly media: PreviewMedia | null;
  readonly clipId: string | null;
  readonly refresh: () => void;
}

export function useSpeedPreviewMedia(options: {
  readonly projectId: string | null;
  readonly timeline: (SpeedTimelineLike & {readonly revision?: number}) | null;
  readonly clip: SpeedClipLike | null | undefined;
  readonly asset: SpeedAssetLike | null | undefined;
  readonly active: boolean;
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly processingItems: readonly SpeedProcessingItem[];
  readonly rpc: SpeedPreviewMediaRpc;
}): UseSpeedPreviewMediaResult {
  const {projectId, timeline, clip, asset, active, online, authenticated, processingItems, rpc} = options;
  const eligible = Boolean(
    active
    && projectId
    && online
    && authenticated
    && clipNeedsPreviewMediaRpc(timeline, clip, asset),
  );
  const clipId = eligible && clip ? clip.id : null;
  const timingSignature = clip?.timing ? JSON.stringify(clip.timing) : 'none';
  const clipProcessingSignature = clipId
    ? processingItems
        .filter(item => item.clipId === clipId)
        .map(item => `${item.taskId}:${item.kind}:${item.status}:${item.progress ?? ''}:${item.reason ?? ''}`)
        .sort()
        .join('|')
    : '';

  const [state, setState] = useState<{readonly clipId: string | null; readonly media: PreviewMedia | null}>({
    clipId: null,
    media: null,
  });
  const controllerRef = useRef<SpeedPreviewMediaController | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    if (!eligible || !projectId || !clipId) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      setState(prev => (prev.clipId === null && prev.media === null ? prev : {clipId: null, media: null}));
      return;
    }
    setState(prev => (prev.clipId === clipId ? prev : {clipId, media: null}));
    const controller = createSpeedPreviewMediaController({
      projectId,
      clipId,
      read: signal => rpcRef.current('timeline.preview.media', {projectId, clipId}, {signal}),
      onMedia: media => setState(prev => (
        prev.clipId === clipId && JSON.stringify(prev.media) === JSON.stringify(media)
          ? prev
          : {clipId, media}
      )),
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [eligible, projectId, clipId, timeline?.revision, timingSignature]);

  // Re-check media URL when processing list reports a clip's task changed state (e.g. ready or retried).
  const prevProcSig = useRef<string>(clipProcessingSignature);
  useEffect(() => {
    if (prevProcSig.current === clipProcessingSignature) return;
    prevProcSig.current = clipProcessingSignature;
    if (eligible && clipId && clipProcessingSignature) {
      controllerRef.current?.refresh();
    }
  }, [eligible, clipId, clipProcessingSignature]);

  const refresh = useCallback(() => {
    controllerRef.current?.refresh();
  }, []);

  return {
    media: state.clipId === clipId ? state.media : null,
    clipId,
    refresh,
  };
}
