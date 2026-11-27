/** Polling controller & React hook for `timeline.processing.*` (F6).
 *
 * Polls `timeline.processing.list` every 2000 ms ONLY while `capabilities.speed === true`
 * and at least one reverse/optical clip exists; stops polling automatically as
 * soon as no task is `queued` or `running`.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {speedProcessingListResponseSchema} from '../../../../packages/contracts/src/timeline-speed.ts';
import type {SpeedProcessingItem} from '../../../../packages/contracts/src/timeline-speed.ts';
import {clipNeedsSpeedProcessing, processingItemActive, timelineSpeedEnabled} from './speed-model.ts';
import type {SpeedClipLike, SpeedTimelineLike} from './speed-model.ts';

export const SPEED_PROCESSING_POLL_INTERVAL_MS = 2000;

export type SpeedProcessingRpc = (
  operation: string,
  input: unknown,
  options?: {readonly signal?: AbortSignal},
) => Promise<unknown>;

export interface SpeedProcessingController {
  start(): void;
  stop(): void;
  refresh(): void;
  dispose(): void;
}

function parseProcessingItems(value: unknown): SpeedProcessingItem[] {
  const parsed = speedProcessingListResponseSchema.safeParse(value);
  return parsed.success ? parsed.data.items : [];
}

/** Pure, timer-injectable poller so unit tests can verify 2s interval,
 * immediate stop when no active items remain, and stale-response fencing. */
export function createSpeedProcessingPoller(options: {
  readonly projectId: string;
  readonly list: (signal: AbortSignal) => Promise<unknown>;
  readonly onItems: (items: readonly SpeedProcessingItem[]) => void;
  readonly intervalMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): SpeedProcessingController {
  const intervalMs = options.intervalMs ?? SPEED_PROCESSING_POLL_INTERVAL_MS;
  const schedule = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelTimer = options.clearTimeoutFn ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let running = false;
  let disposed = false;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

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

  function pollOnce(): void {
    if (disposed || !running) return;
    clearPending();
    const requestSeq = ++seq;
    const ac = new AbortController();
    abortController = ac;
    void Promise.resolve(options.list(ac.signal))
      .then(
        response => {
          if (disposed || !running || requestSeq !== seq || ac.signal.aborted) return;
          const items = parseProcessingItems(response);
          options.onItems(items);
          if (items.some(processingItemActive)) {
            timer = schedule(() => {
              timer = null;
              pollOnce();
            }, intervalMs);
          }
        },
        () => {
          // Transient list error does not crash the timeline; stop polling until next trigger.
        },
      )
      .finally(() => {
        if (abortController === ac) abortController = null;
      });
  }

  function start(): void {
    if (disposed) return;
    running = true;
    pollOnce();
  }

  function refresh(): void {
    if (disposed) return;
    running = true;
    pollOnce();
  }

  function stop(): void {
    running = false;
    seq += 1;
    clearPending();
  }

  function dispose(): void {
    stop();
    disposed = true;
  }

  return {start, stop, refresh, dispose};
}

function makeRetryRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `speed-retry-${crypto.randomUUID()}`;
  }
  return `speed-retry-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export interface UseSpeedProcessingResult {
  readonly items: readonly SpeedProcessingItem[];
  readonly busyTaskIds: ReadonlySet<string>;
  readonly retry: (taskId: string) => Promise<void>;
  readonly cancel: (taskId: string) => Promise<void>;
  readonly refresh: () => void;
}

export function useSpeedProcessing(options: {
  readonly projectId: string | null;
  readonly timeline: (SpeedTimelineLike & {readonly revision?: number; readonly clips?: readonly SpeedClipLike[]}) | null;
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly rpc: SpeedProcessingRpc;
  readonly onError?: (error: unknown) => void;
}): UseSpeedProcessingResult {
  const {projectId, timeline, online, authenticated, rpc, onError} = options;
  const speedEnabled = timelineSpeedEnabled(timeline);
  const clipTriggerKey = useMemo(() => {
    if (!speedEnabled || !timeline?.clips?.length) return '';
    return timeline.clips
      .filter(clipNeedsSpeedProcessing)
      .map(clip => `${clip.id}:${clip.timing?.profile === 'timeline-speed-v1' ? `${clip.timing.basis.speed.kind}:${clip.timing.view.direction}:${clip.timing.interpolation}` : ''}`)
      .sort()
      .join('|');
  }, [speedEnabled, timeline?.clips]);

  const shouldPoll = Boolean(speedEnabled && projectId && online && authenticated && clipTriggerKey);
  const [items, setItems] = useState<readonly SpeedProcessingItem[]>([]);
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const pollerRef = useRef<SpeedProcessingController | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!shouldPoll || !projectId) {
      pollerRef.current?.dispose();
      pollerRef.current = null;
      setItems([]);
      return;
    }
    const poller = createSpeedProcessingPoller({
      projectId,
      list: signal => rpcRef.current('timeline.processing.list', {projectId}, {signal}),
      onItems: next => setItems(next),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [shouldPoll, projectId, clipTriggerKey, timeline?.revision]);

  const retry = useCallback(async (taskId: string): Promise<void> => {
    if (!projectId || !speedEnabled) return;
    setBusyTaskIds(prev => new Set([...prev, taskId]));
    try {
      await rpcRef.current('timeline.processing.retry', {
        projectId,
        taskId,
        requestId: makeRetryRequestId(),
      });
      pollerRef.current?.refresh();
    } catch (error) {
      onErrorRef.current?.(error);
    } finally {
      setBusyTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [projectId, speedEnabled]);

  const cancel = useCallback(async (taskId: string): Promise<void> => {
    if (!projectId || !speedEnabled) return;
    setBusyTaskIds(prev => new Set([...prev, taskId]));
    try {
      await rpcRef.current('timeline.processing.cancel', {projectId, taskId});
      pollerRef.current?.refresh();
    } catch (error) {
      onErrorRef.current?.(error);
    } finally {
      setBusyTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [projectId, speedEnabled]);

  const refresh = useCallback(() => {
    pollerRef.current?.refresh();
  }, []);

  return {items, busyTaskIds, retry, cancel, refresh};
}
