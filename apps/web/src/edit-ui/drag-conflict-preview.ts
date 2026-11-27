/** Format-5 live drag conflict preview (Q-16).
 *
 * While dragging a clip or library asset over a format-5 timeline, once the
 * snapped drop target settles for ~150 ms, runs a read-only `sequence.preview`
 * with the exact same command that dropping would submit. When the server
 * reports `SEQUENCE_EDIT_ANCHOR_CONFLICT`, marks the drop indicator as danger
 * and highlights the conflicting clip/subtitle ids before release.
 *
 * Never mutates project data, never blocks drag frames, aborts superseded or
 * cancelled requests, and stays silent on network/other errors so releasing
 * still follows the existing submit/toast path. Format 3/4 never wires this.
 */
import {sequenceSyncIntent} from '../../../../packages/contracts/src/sequence-sync.ts';
import type {SequenceSyncCommand} from '../../../../packages/contracts/src/sequence-sync.ts';
import {extractSequenceErrorIds} from './lost-response.ts';
import {format5InsertAssetCommand, format5MoveCommand, format5MoveOffTrackCommand} from './session.ts';

export const DRAG_CONFLICT_PREVIEW_DELAY_MS = 150;

export interface Format5DragPreviewTarget {
  readonly projectId: string;
  readonly revision: number;
  readonly kind: 'clip' | 'asset';
  readonly id: string;
  readonly trackId: string;
  readonly startFrame: number;
}

export interface Format5DragPreviewTimeline {
  readonly clips: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startFrame: number;
  }[];
  readonly mainTrack?: {readonly trackId?: string} | null;
}

export interface DragConflictPreviewResult {
  readonly conflict: true;
  readonly ids: readonly string[];
}

export interface DragConflictState {
  readonly key: string;
  readonly ids: ReadonlySet<string>;
}

export type Format5DragConflictPreviewer = (
  target: Format5DragPreviewTarget,
  signal: AbortSignal,
) => Promise<DragConflictPreviewResult | null>;

export type Format5PreviewRpc = (
  operation: string,
  input: unknown,
  options?: {readonly signal?: AbortSignal},
) => Promise<unknown>;

export function dragPreviewTargetKey(target: Format5DragPreviewTarget): string {
  return `${target.projectId}:${target.revision}:${target.kind}:${target.id}:${target.trackId}:${target.startFrame}`;
}

/** Builds the exact format-5 command that dropping at `target` submits. */
export function buildFormat5DragCommand(
  target: Format5DragPreviewTarget,
  timeline: Format5DragPreviewTimeline,
): SequenceSyncCommand {
  const mainTrackId = timeline.mainTrack?.trackId ?? null;
  if (target.kind === 'asset') {
    return format5InsertAssetCommand(
      target.id,
      target.trackId === mainTrackId ? null : target.trackId,
      Math.max(0, Math.round(target.startFrame)),
    );
  }
  if (target.trackId === mainTrackId && mainTrackId !== null) {
    const sorted = timeline.clips
      .filter(item => item.trackId === mainTrackId && item.id !== target.id)
      .sort((left, right) => left.startFrame - right.startFrame);
    const beforeClipId = sorted.find(item => item.startFrame > target.startFrame)?.id ?? null;
    return format5MoveCommand(target.id, beforeClipId);
  }
  return format5MoveOffTrackCommand(target.id, target.trackId, target.startFrame);
}

interface PreviewOutcomeCheck {
  readonly code: string | null;
  readonly ids: readonly string[];
}

function readPreviewFailure(value: unknown): PreviewOutcomeCheck | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {ok?: unknown; code?: unknown};
  if (record.ok === false && typeof record.code === 'string' && record.code) {
    return {code: record.code, ids: extractSequenceErrorIds(value) ?? []};
  }
  return null;
}

function readThrownFailure(error: unknown): PreviewOutcomeCheck {
  if (!error || typeof error !== 'object') return {code: null, ids: []};
  const code = typeof (error as {code?: unknown}).code === 'string' ? (error as {code: string}).code : null;
  return {code, ids: extractSequenceErrorIds(error) ?? []};
}

function dragPreviewRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `f5-drag-preview-${random}`;
}

/** Runs one read-only `sequence.preview` for a live drag target. Returns
 * `{conflict: true, ids}` only on `SEQUENCE_EDIT_ANCHOR_CONFLICT`; any success,
 * abort, network failure, or unrelated error resolves to `null`. */
export async function previewFormat5DragConflict(
  rpc: Format5PreviewRpc,
  target: Format5DragPreviewTarget,
  timeline: Format5DragPreviewTimeline,
  signal: AbortSignal,
): Promise<DragConflictPreviewResult | null> {
  if (signal.aborted) return null;
  const run = async (command: SequenceSyncCommand): Promise<PreviewOutcomeCheck | null> => {
    try {
      const response = await rpc(
        'sequence.preview',
        {
          projectId: target.projectId,
          requestId: dragPreviewRequestId(),
          intents: [sequenceSyncIntent(command)],
        },
        {signal},
      );
      return readPreviewFailure(response);
    } catch (error) {
      if (signal.aborted) return null;
      return readThrownFailure(error);
    }
  };

  const baseCommand = buildFormat5DragCommand(target, timeline);
  let failure = await run(baseCommand);
  if (signal.aborted) return null;

  // Linked-clip off-track moves ask for a copy identity before checking anchor
  // overlap; preview once more with a synthetic copy id (still read-only).
  if (failure?.code === 'COPY_NODE_REQUIRED' && target.kind === 'clip') {
    const copyNodeId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `preview-copy-${Date.now()}`;
    failure = await run({...baseCommand, copyNodeId} as SequenceSyncCommand);
    if (signal.aborted) return null;
  }

  if (failure?.code === 'SEQUENCE_EDIT_ANCHOR_CONFLICT') {
    return {conflict: true, ids: failure.ids};
  }
  return null;
}

export interface DragConflictPreviewController {
  update(target: Format5DragPreviewTarget | null): void;
  clear(): void;
  dispose(): void;
}

export function createDragConflictPreviewController(options: {
  readonly preview: Format5DragConflictPreviewer;
  readonly onConflict: (conflict: DragConflictState | null) => void;
  readonly delayMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}): DragConflictPreviewController {
  const delayMs = options.delayMs ?? DRAG_CONFLICT_PREVIEW_DELAY_MS;
  const schedule = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelTimer = options.clearTimeoutFn ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let activeKey: string | null = null;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let currentConflict: DragConflictState | null = null;
  let disposed = false;

  function publishConflict(next: DragConflictState | null): void {
    if (disposed) return;
    if (currentConflict === null && next === null) return;
    currentConflict = next;
    options.onConflict(next);
  }

  function cancelPending(): void {
    if (timer !== null) {
      cancelTimer(timer);
      timer = null;
    }
    if (controller !== null) {
      controller.abort();
      controller = null;
    }
  }

  function update(target: Format5DragPreviewTarget | null): void {
    if (disposed) return;
    const nextKey = target ? dragPreviewTargetKey(target) : null;
    if (nextKey === activeKey) return;

    cancelPending();
    seq += 1;
    activeKey = nextKey;
    publishConflict(null);

    if (!target || !nextKey) return;
    const requestSeq = seq;
    const requestKey = nextKey;

    timer = schedule(() => {
      timer = null;
      if (disposed || requestSeq !== seq || activeKey !== requestKey) return;
      const abortController = new AbortController();
      controller = abortController;
      void Promise.resolve(options.preview(target, abortController.signal))
        .then(
          result => {
            if (disposed || requestSeq !== seq || activeKey !== requestKey || abortController.signal.aborted) {
              return;
            }
            if (result?.conflict) {
              publishConflict({key: requestKey, ids: new Set(result.ids)});
            } else {
              publishConflict(null);
            }
          },
          () => {
            // Silent during drag; releasing falls back to the normal submit path.
          },
        )
        .finally(() => {
          if (controller === abortController) controller = null;
        });
    }, delayMs);
  }

  function clear(): void {
    update(null);
  }

  function dispose(): void {
    cancelPending();
    seq += 1;
    activeKey = null;
    currentConflict = null;
    disposed = true;
  }

  return {update, clear, dispose};
}
