/** Polling controller & React hook for `timeline.processing.*` (F6).
 *
 * Polls `timeline.processing.list` every 2000 ms ONLY while `capabilities.speed === true`
 * and at least one reverse/optical/curve clip exists; retries retryable transport errors
 * (e.g. HTTP 503, network glitches) with exponential backoff until recovery, terminal
 * failure, or bounded unknown status, and stops immediately on leave/dispose.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {timelineProcessingResponseSchemas} from '../../../../packages/contracts/src/timeline-processing.ts';
import type {SpeedProcessingItem} from '../../../../packages/contracts/src/timeline-speed.ts';
import {clipNeedsSpeedProcessing, processingItemActive, timelineSpeedEnabled} from './speed-model.ts';
import type {SpeedClipLike, SpeedTimelineLike} from './speed-model.ts';

export const SPEED_PROCESSING_POLL_INTERVAL_MS = 2000;
export const SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS = 30_000;
export const SPEED_PROCESSING_MAX_CONSECUTIVE_FAILURES = 5;

export type SpeedProcessingPollState = 'idle' | 'polling' | 'retrying' | 'unknown' | 'failed';

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
  getState(): SpeedProcessingPollState;
}

const NON_RETRYABLE_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'BAD_REQUEST',
]);

/** Classifies transport/RPC errors from status polling: 5xx, 408, 429, and network
 * failures are retryable; aborts and definitive 4xx errors stop immediately. */
export function isRetryableProcessingPollError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (record.retryable === false) return false;
    if (record.retryable === true) return true;
    const status = typeof record.status === 'number' && Number.isFinite(record.status) ? record.status : undefined;
    if (status !== undefined) {
      if (status === 408 || status === 429 || status >= 500) return true;
      if (status >= 400 && status < 500) return false;
    }
    if (record.definitive === true) return false;
    if (typeof record.code === 'string' && NON_RETRYABLE_CODES.has(record.code)) return false;
  }
  return true;
}

/** Exponential backoff for consecutive retryable polling failures:
 * 1 -> base (2s), 2 -> 4s, 3 -> 8s, 4 -> 16s, capped at `maxBackoffMs` (30s). */
export function speedProcessingBackoffDelayMs(
  consecutiveFailures: number,
  baseIntervalMs = SPEED_PROCESSING_POLL_INTERVAL_MS,
  maxBackoffMs = SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS,
): number {
  const safeFailures = Math.max(1, Math.trunc(consecutiveFailures));
  const raw = baseIntervalMs * (2 ** (safeFailures - 1));
  return Math.min(maxBackoffMs, raw);
}

/** Pure, timer-injectable poller so unit tests can verify 2s interval,
 * exponential retry backoff on transient 503s, bounded unknown stop on repeated
 * failures, immediate stop when terminal/disposed, and stale-response fencing. */
export function createSpeedProcessingPoller(options: {
  readonly projectId: string;
  readonly list: (signal: AbortSignal) => Promise<unknown>;
  readonly onItems: (items: readonly SpeedProcessingItem[]) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): SpeedProcessingController {
  const intervalMs = options.intervalMs ?? SPEED_PROCESSING_POLL_INTERVAL_MS;
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
      pollOnce();
    }, delayMs);
  }

  function pollOnce(): void {
    if (disposed || !running) return;
    clearPending();
    const requestSeq = ++seq;
    const ac = new AbortController();
    abortController = ac;
    let requestPromise: Promise<unknown>;
    try {
      requestPromise = Promise.resolve(options.list(ac.signal));
    } catch (syncError) {
      requestPromise = Promise.reject(syncError);
    }
    void requestPromise
      .then(
        response => {
          if (disposed || !running || requestSeq !== seq || ac.signal.aborted) return;
          const parsed = timelineProcessingResponseSchemas['timeline.processing.list'].safeParse(response);
          if (!parsed.success) {
            handlePollFailure(new Error('INVALID_PROCESSING_LIST_RESPONSE'));
            return;
          }
          consecutiveFailures = 0;
          const items = parsed.data.items;
          options.onItems(items);
          if (items.some(processingItemActive)) {
            setState('polling');
            timer = schedule(() => {
              timer = null;
              pollOnce();
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

  function start(): void {
    if (disposed) return;
    consecutiveFailures = 0;
    running = true;
    setState('polling');
    pollOnce();
  }

  function refresh(): void {
    if (disposed) return;
    consecutiveFailures = 0;
    running = true;
    setState('polling');
    pollOnce();
  }

  function stop(): void {
    running = false;
    consecutiveFailures = 0;
    seq += 1;
    clearPending();
    setState('idle');
  }

  function dispose(): void {
    stop();
    disposed = true;
  }

  return {start, stop, refresh, dispose, getState: () => state};
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
  readonly pollState: SpeedProcessingPollState;
  readonly retry: (taskId: string) => Promise<void>;
  readonly cancel: (taskId: string) => Promise<void>;
  readonly refresh: () => void;
}

export function useSpeedProcessing(options: {
  readonly projectId: string | null;
  readonly timeline: (SpeedTimelineLike & {readonly revision?: number; readonly clips?: readonly SpeedClipLike[]}) | null;
  readonly active?: boolean;
  readonly scopeKey?: string;
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly rpc: SpeedProcessingRpc;
  readonly onError?: (error: unknown) => void;
}): UseSpeedProcessingResult {
  const {projectId, timeline, active = true, scopeKey = '', online, authenticated, rpc, onError} = options;
  const speedEnabled = timelineSpeedEnabled(timeline);
  const clipTriggerKey = useMemo(() => {
    if (!speedEnabled || !timeline?.clips?.length) return '';
    return timeline.clips
      .filter(clipNeedsSpeedProcessing)
      .map(clip => `${clip.id}:${clip.timing?.profile === 'timeline-speed-v1' ? `${clip.timing.basis.speed.kind}:${clip.timing.view.direction}:${clip.timing.interpolation}` : ''}`)
      .sort()
      .join('|');
  }, [speedEnabled, timeline?.clips]);

  const shouldPoll = Boolean(active && speedEnabled && projectId && online && authenticated && clipTriggerKey);
  const [items, setItems] = useState<readonly SpeedProcessingItem[]>([]);
  const [pollState, setPollState] = useState<SpeedProcessingPollState>('idle');
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
      setPollState('idle');
      return;
    }
    const poller = createSpeedProcessingPoller({
      projectId,
      list: signal => rpcRef.current('timeline.processing.list', {projectId}, {signal}),
      onItems: next => setItems(next),
      onStateChange: nextState => setPollState(nextState),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [shouldPoll, projectId, clipTriggerKey, timeline?.revision, scopeKey]);

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

  return {items, busyTaskIds, pollState, retry, cancel, refresh};
}
