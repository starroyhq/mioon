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

export interface SpeedPreviewMediaScopeInput {
  readonly eligible: boolean;
  readonly projectId: string | null;
  readonly clipId: string | null;
  readonly timelineRevision: number | null;
  readonly timingSignature: string;
}

export interface ScopedSpeedPreviewMediaController {
  update(scope: SpeedPreviewMediaScopeInput): void;
  notifyProcessingSignature(clipId: string | null, signature: string): void;
  refresh(): void;
  dispose(): void;
  getState(): SpeedProcessingPollState;
  getActiveClipId(): string | null;
}

export function createSpeedPreviewMediaController(options: {
  readonly projectId: string;
  readonly clipId: string;
  readonly read: (signal: AbortSignal) => Promise<unknown>;
  readonly onMedia: (media: PreviewMedia | null, clipId: string) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly isCurrent?: (clipId: string) => boolean;
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

  function isResponseCurrent(requestSeq: number, ac: AbortController): boolean {
    if (disposed || !running || requestSeq !== seq || ac.signal.aborted) return false;
    if (options.isCurrent && !options.isCurrent(options.clipId)) return false;
    return true;
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
          if (!isResponseCurrent(requestSeq, ac)) return;
          const media = parsePreviewMediaForClip(response, options.projectId, options.clipId);
          if (media === null) {
            handlePollFailure(new Error('INVALID_PREVIEW_MEDIA_RESPONSE'));
            return;
          }
          consecutiveFailures = 0;
          options.onMedia(media, options.clipId);
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
          if (!isResponseCurrent(requestSeq, ac)) return;
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

/** Scope-aware preview media poller: immediately clears timers & aborts in-flight
 * requests on clip switch or preview close, discards late replies by both clip ID
 * and monotonic generation, and avoids duplicate refresh on clip change. */
export function createScopedSpeedPreviewMediaController(options: {
  readonly read: (projectId: string, clipId: string, signal: AbortSignal) => Promise<unknown>;
  readonly onMedia: (clipId: string | null, media: PreviewMedia | null) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): ScopedSpeedPreviewMediaController {
  let disposed = false;
  let generation = 0;
  let state: SpeedProcessingPollState = 'idle';
  let activeClipId: string | null = null;
  let controller: SpeedPreviewMediaController | null = null;
  let lastScopeKey = '';
  let lastProcKey: {clipId: string | null; signature: string | null} = {clipId: null, signature: null};

  function publishState(next: SpeedProcessingPollState, error?: unknown): void {
    if (state === next && error === undefined) return;
    state = next;
    options.onStateChange?.(next, error);
  }

  function disposeCurrent(): void {
    generation += 1;
    if (controller) {
      controller.dispose();
      controller = null;
    }
  }

  function update(scope: SpeedPreviewMediaScopeInput): void {
    if (disposed) return;
    if (!scope.eligible || !scope.projectId || !scope.clipId) {
      disposeCurrent();
      activeClipId = null;
      lastScopeKey = '';
      lastProcKey = {clipId: null, signature: null};
      publishState('idle');
      options.onMedia(null, null);
      return;
    }
    const nextScopeKey = `${scope.projectId}:${scope.clipId}:${scope.timelineRevision ?? ''}:${scope.timingSignature}`;
    if (nextScopeKey === lastScopeKey && controller) return;

    const clipChanged = activeClipId !== scope.clipId;
    disposeCurrent();
    const myGeneration = generation;
    const projectId = scope.projectId;
    const clipId = scope.clipId;
    activeClipId = clipId;
    lastScopeKey = nextScopeKey;
    if (clipChanged) {
      lastProcKey = {clipId, signature: null};
      options.onMedia(clipId, null);
    }

    const nextController = createSpeedPreviewMediaController({
      projectId,
      clipId,
      intervalMs: options.intervalMs,
      maxBackoffMs: options.maxBackoffMs,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
      read: signal => options.read(projectId, clipId, signal),
      isCurrent: responseClipId =>
        !disposed && myGeneration === generation && controller === nextController && activeClipId === responseClipId,
      onMedia: (media, responseClipId) => {
        if (disposed || myGeneration !== generation || controller !== nextController || activeClipId !== responseClipId) return;
        options.onMedia(responseClipId, media);
      },
      onStateChange: (nextState, error) => {
        if (disposed || myGeneration !== generation || controller !== nextController || activeClipId !== clipId) return;
        publishState(nextState, error);
      },
    });
    controller = nextController;
    nextController.start();
  }

  function notifyProcessingSignature(clipId: string | null, signature: string): void {
    if (disposed) return;
    const sameClip = clipId !== null && clipId === activeClipId && lastProcKey.clipId === clipId;
    const prevSig = lastProcKey.signature;
    lastProcKey = {clipId, signature};
    if (sameClip && prevSig !== null && signature && prevSig !== signature) {
      controller?.refresh();
    }
  }

  function refresh(): void {
    if (disposed) return;
    controller?.refresh();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disposeCurrent();
    activeClipId = null;
    lastScopeKey = '';
    lastProcKey = {clipId: null, signature: null};
    publishState('idle');
  }

  return {
    update,
    notifyProcessingSignature,
    refresh,
    dispose,
    getState: () => state,
    getActiveClipId: () => activeClipId,
  };
}

export interface UseSpeedPreviewMediaResult {
  readonly media: PreviewMedia | null;
  readonly clipId: string | null;
  readonly pollState: SpeedProcessingPollState;
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
  const timelineRevision = timeline?.revision ?? null;
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
  const [pollState, setPollState] = useState<SpeedProcessingPollState>('idle');
  const managerRef = useRef<ScopedSpeedPreviewMediaController | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    const manager = createScopedSpeedPreviewMediaController({
      read: (pid, cid, signal) => rpcRef.current('timeline.preview.media', {projectId: pid, clipId: cid}, {signal}),
      onMedia: (nextClipId, media) => setState(prev => (
        prev.clipId === nextClipId && JSON.stringify(prev.media) === JSON.stringify(media)
          ? prev
          : {clipId: nextClipId, media}
      )),
      onStateChange: nextState => setPollState(nextState),
    });
    managerRef.current = manager;
    return () => {
      manager.dispose();
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, []);

  useEffect(() => {
    managerRef.current?.update({
      eligible,
      projectId,
      clipId,
      timelineRevision,
      timingSignature,
    });
  }, [eligible, projectId, clipId, timelineRevision, timingSignature]);

  useEffect(() => {
    managerRef.current?.notifyProcessingSignature(clipId, clipProcessingSignature);
  }, [clipId, clipProcessingSignature]);

  const refresh = useCallback(() => {
    managerRef.current?.refresh();
  }, []);

  return {
    media: state.clipId === clipId ? state.media : null,
    clipId,
    pollState,
    refresh,
  };
}
