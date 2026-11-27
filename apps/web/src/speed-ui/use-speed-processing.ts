/** Polling controller & React hook for `timeline.processing.*` (F6).
 *
 * Polls `timeline.processing.list` every 2000 ms ONLY while `capabilities.speed === true`
 * and at least one reverse/optical/curve clip exists; retries retryable transport errors
 * (e.g. HTTP 503, network glitches) with exponential backoff until recovery, terminal
 * failure, or bounded unknown status, and stops immediately on leave/dispose.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {speedProcessingListResponseSchema} from '../../../../packages/contracts/src/timeline-speed.ts';
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

export interface SpeedProcessingScopeInput {
  readonly active: boolean;
  readonly projectId: string | null;
  readonly timelineRevision: number | null;
  readonly clipTriggerKey: string;
  readonly selectedClipId: string | null;
  readonly selectedClipNeedsProcessing: boolean;
  readonly forceProjectWide?: boolean;
  readonly scopeKey?: string;
}

export interface ScopedSpeedProcessingController {
  update(scope: SpeedProcessingScopeInput): void;
  refresh(): void;
  dispose(): void;
  getState(): SpeedProcessingPollState;
  getActiveClipId(): string | null;
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
  readonly clipId?: string | null;
  readonly list: (signal: AbortSignal, clipId: string | null) => Promise<unknown>;
  readonly onItems: (items: readonly SpeedProcessingItem[], clipId: string | null) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly isCurrent?: (clipId: string | null) => boolean;
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
  const clipId = options.clipId ?? null;

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
    if (options.isCurrent && !options.isCurrent(clipId)) return false;
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
      requestPromise = Promise.resolve(options.list(ac.signal, clipId));
    } catch (syncError) {
      requestPromise = Promise.reject(syncError);
    }
    void requestPromise
      .then(
        response => {
          if (!isResponseCurrent(requestSeq, ac)) return;
          const parsed = speedProcessingListResponseSchema.safeParse(response);
          if (!parsed.success) {
            handlePollFailure(new Error('INVALID_PROCESSING_LIST_RESPONSE'));
            return;
          }
          consecutiveFailures = 0;
          const items = parsed.data.items;
          options.onItems(items, clipId);
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
          if (!isResponseCurrent(requestSeq, ac)) return;
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

/** Scope-aware controller managing clip switches, panel/preview close, rapid
 * A->B->A transitions, aborting in-flight requests, cancelling backoff timers,
 * and fencing late responses by both clip ID and monotonic generation. */
export function createScopedSpeedProcessingController(options: {
  readonly list: (projectId: string, signal: AbortSignal, clipId: string | null) => Promise<unknown>;
  readonly onItems: (items: readonly SpeedProcessingItem[]) => void;
  readonly onStateChange?: (state: SpeedProcessingPollState, error?: unknown) => void;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxConsecutiveFailures?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): ScopedSpeedProcessingController {
  let disposed = false;
  let generation = 0;
  let state: SpeedProcessingPollState = 'idle';
  let poller: SpeedProcessingController | null = null;
  let boundClipId: string | null = null;
  let lastScope: (SpeedProcessingScopeInput & {readonly eligible: boolean; readonly projectEligible: boolean}) | null = null;

  function publishState(next: SpeedProcessingPollState, error?: unknown): void {
    if (state === next && error === undefined) return;
    state = next;
    options.onStateChange?.(next, error);
  }

  function disposePoller(): void {
    generation += 1;
    if (poller) {
      poller.dispose();
      poller = null;
    }
  }

  function startPoller(projectId: string, clipId: string | null): void {
    disposePoller();
    const myGeneration = generation;
    boundClipId = clipId;
    const nextPoller = createSpeedProcessingPoller({
      projectId,
      clipId,
      intervalMs: options.intervalMs,
      maxBackoffMs: options.maxBackoffMs,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
      list: (signal, requestClipId) => options.list(projectId, signal, requestClipId),
      isCurrent: requestClipId => {
        if (disposed || myGeneration !== generation || poller !== nextPoller) return false;
        if (requestClipId !== null && boundClipId !== requestClipId) return false;
        return true;
      },
      onItems: (items, requestClipId) => {
        if (disposed || myGeneration !== generation || poller !== nextPoller) return;
        if (requestClipId !== null && boundClipId !== requestClipId) return;
        options.onItems(items);
      },
      onStateChange: (nextState, error) => {
        if (disposed || myGeneration !== generation || poller !== nextPoller) return;
        publishState(nextState, error);
      },
    });
    poller = nextPoller;
    nextPoller.start();
  }

  function update(scope: SpeedProcessingScopeInput): void {
    if (disposed) return;
    const prev = lastScope;
    const projectEligible = Boolean(scope.active && scope.projectId && scope.clipTriggerKey);
    const leftClipToEmpty = Boolean(
      prev
      && prev.selectedClipId !== null
      && scope.selectedClipId === null
      && !scope.forceProjectWide,
    );
    const clipRequiresPoll = scope.selectedClipId === null
      ? !leftClipToEmpty
      : (scope.selectedClipNeedsProcessing || Boolean(scope.forceProjectWide));
    const eligible = projectEligible && clipRequiresPoll;
    const normalized = {...scope, eligible, projectEligible};

    const projectOrTimelineChanged = !prev
      || prev.projectId !== scope.projectId
      || prev.timelineRevision !== scope.timelineRevision
      || prev.clipTriggerKey !== scope.clipTriggerKey
      || (prev.scopeKey ?? '') !== (scope.scopeKey ?? '')
      || Boolean(prev.forceProjectWide) !== Boolean(scope.forceProjectWide);

    if (!eligible || !scope.projectId) {
      disposePoller();
      boundClipId = scope.selectedClipId;
      lastScope = normalized;
      publishState('idle');
      if (!projectEligible) options.onItems([]);
      return;
    }

    const prevClipId = prev?.selectedClipId ?? null;
    const nextClipId = scope.selectedClipId;
    const clipSwitched = prevClipId !== null && prevClipId !== nextClipId;
    const initialClipBind = prevClipId === null && nextClipId !== null;

    // Adopting an already-running initial project poll on the very first clip selection
    // (`null -> clipA`) avoids cancelling the initial 200ms timeline read; switching away
    // from any selected clip (`clipA -> clipB`, `clipA -> null`) or leaving a non-polling
    // state immediately cancels old timers, aborts in-flight requests, and starts fresh.
    if (!projectOrTimelineChanged && !clipSwitched && initialClipBind && poller && poller.getState() === 'polling') {
      boundClipId = nextClipId;
      lastScope = normalized;
      return;
    }

    const becameEligible = !prev?.eligible;
    if (projectOrTimelineChanged || becameEligible || clipSwitched || initialClipBind || !poller) {
      lastScope = normalized;
      startPoller(scope.projectId, nextClipId);
      return;
    }

    lastScope = normalized;
  }

  function refresh(): void {
    if (disposed) return;
    if (poller) {
      poller.refresh();
      return;
    }
    if (lastScope?.projectEligible && lastScope.projectId) {
      startPoller(lastScope.projectId, lastScope.selectedClipId);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disposePoller();
    boundClipId = null;
    lastScope = null;
    publishState('idle');
  }

  return {
    update,
    refresh,
    dispose,
    getState: () => state,
    getActiveClipId: () => boundClipId,
  };
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
  readonly selectedClipId?: string | null;
  readonly forceProjectWide?: boolean;
  readonly scopeKey?: string;
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly rpc: SpeedProcessingRpc;
  readonly onError?: (error: unknown) => void;
}): UseSpeedProcessingResult {
  const {
    projectId,
    timeline,
    active = true,
    selectedClipId = null,
    forceProjectWide = false,
    scopeKey = '',
    online,
    authenticated,
    rpc,
    onError,
  } = options;
  const speedEnabled = timelineSpeedEnabled(timeline);
  const clipTriggerKey = useMemo(() => {
    if (!speedEnabled || !timeline?.clips?.length) return '';
    return timeline.clips
      .filter(clipNeedsSpeedProcessing)
      .map(clip => `${clip.id}:${clip.timing?.profile === 'timeline-speed-v1' ? `${clip.timing.basis.speed.kind}:${clip.timing.view.direction}:${clip.timing.interpolation}` : ''}`)
      .sort()
      .join('|');
  }, [speedEnabled, timeline?.clips]);

  const selectedClipNeedsProcessing = useMemo(() => {
    if (!speedEnabled || !selectedClipId || !timeline?.clips?.length) return false;
    const clip = timeline.clips.find(item => item.id === selectedClipId);
    return clipNeedsSpeedProcessing(clip);
  }, [speedEnabled, selectedClipId, timeline?.clips]);

  const activeFlag = Boolean(active && speedEnabled && projectId && online && authenticated);
  const timelineRevision = timeline?.revision ?? null;

  const [items, setItems] = useState<readonly SpeedProcessingItem[]>([]);
  const [pollState, setPollState] = useState<SpeedProcessingPollState>('idle');
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const managerRef = useRef<ScopedSpeedProcessingController | null>(null);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const manager = createScopedSpeedProcessingController({
      list: (pid, signal) => rpcRef.current('timeline.processing.list', {projectId: pid}, {signal}),
      onItems: next => setItems(next),
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
      active: activeFlag,
      projectId,
      timelineRevision,
      clipTriggerKey,
      selectedClipId,
      selectedClipNeedsProcessing,
      forceProjectWide,
      scopeKey,
    });
  }, [
    activeFlag,
    projectId,
    timelineRevision,
    clipTriggerKey,
    selectedClipId,
    selectedClipNeedsProcessing,
    forceProjectWide,
    scopeKey,
  ]);

  const retry = useCallback(async (taskId: string): Promise<void> => {
    if (!projectId || !speedEnabled) return;
    setBusyTaskIds(prev => new Set([...prev, taskId]));
    try {
      await rpcRef.current('timeline.processing.retry', {
        projectId,
        taskId,
        requestId: makeRetryRequestId(),
      });
      managerRef.current?.refresh();
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
      managerRef.current?.refresh();
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
    managerRef.current?.refresh();
  }, []);

  return {items, busyTaskIds, pollState, retry, cancel, refresh};
}
