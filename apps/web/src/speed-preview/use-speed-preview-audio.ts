/** Companion backend-PCM audio controller for muted speed-preview clip playback.
 *
 * Keeps `soundAuditionContext()` and `audioPreview` on the `timeline` tab 100%
 * untouched while letting muted constant/curve/reverse speed-clip playback in
 * the `source` tab audition the backend-rendered PCM (keep-pitch in 2×–4×,
 * pitch-shift elsewhere, reversed audio for reverse clips, silent for freeze).
 */
import {useCallback, useEffect, useRef} from 'react';
import {createTimelineAudioPreviewController} from '../use-timeline-audio-preview.ts';
import type {TimelineAudioPreviewContext} from '../use-timeline-audio-preview.ts';

export interface UseSpeedPreviewAudioOptions {
  readonly enabled: boolean;
  readonly context: TimelineAudioPreviewContext;
  readonly getContext: () => TimelineAudioPreviewContext;
  readonly readPlan: (input: Record<string, unknown>, options?: {readonly signal?: AbortSignal}) => Promise<unknown>;
  readonly readContinuousPlan: (input: Record<string, unknown>, options?: {readonly signal?: AbortSignal}) => Promise<unknown>;
}

export interface SpeedPreviewAudioCompanion {
  readonly syncPlayback: (state: {readonly playing: boolean; readonly frame: number; readonly silent: boolean}) => void;
  readonly stop: () => void;
}

export function useSpeedPreviewAudio(options: UseSpeedPreviewAudioOptions): SpeedPreviewAudioCompanion {
  const {enabled, context, getContext, readPlan, readContinuousPlan} = options;
  const controllerRef = useRef<ReturnType<typeof createTimelineAudioPreviewController> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  const readPlanRef = useRef(readPlan);
  readPlanRef.current = readPlan;
  const readContinuousPlanRef = useRef(readContinuousPlan);
  readContinuousPlanRef.current = readContinuousPlan;
  const playEpochRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      playEpochRef.current += 1;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      return;
    }
    if (!controllerRef.current) {
      controllerRef.current = createTimelineAudioPreviewController({
        readPlan: (input, opts) => readPlanRef.current(input as unknown as Record<string, unknown>, opts),
        readContinuousPlan: (input, opts) => readContinuousPlanRef.current(input as unknown as Record<string, unknown>, opts),
        getContext: () => getContextRef.current(),
      });
    }
    controllerRef.current.setContext(context);
  }, [
    enabled,
    context.scope,
    context.executionScope,
    context.projectId,
    context.timelineId,
    context.revision,
    context.durationFrames,
    context.sourceIdentity,
    context.connected,
    context.visible,
    context.hasUnsavedDrafts,
  ]);

  useEffect(() => () => {
    playEpochRef.current += 1;
    controllerRef.current?.dispose();
    controllerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    playEpochRef.current += 1;
    controllerRef.current?.revoke();
  }, []);

  const syncPlayback = useCallback((state: {readonly playing: boolean; readonly frame: number; readonly silent: boolean}) => {
    const controller = controllerRef.current;
    if (!enabledRef.current || !controller) return;
    const epoch = ++playEpochRef.current;
    if (!state.playing || state.silent) {
      controller.revoke();
      return;
    }
    const ctx = getContextRef.current();
    controller.setContext(ctx);
    if (!ctx.connected || !ctx.visible || ctx.durationFrames <= 0) return;
    const frame = Math.max(0, Math.min(ctx.durationFrames - 1, Math.round(state.frame)));
    void (async () => {
      try {
        const prepared = await controller.prepare(frame, ctx);
        if (prepared && playEpochRef.current === epoch && enabledRef.current) {
          await controller.play(ctx);
        }
      } catch {
        // Companion sound failure never blocks muted video preview playback.
      }
    })();
  }, []);

  return {syncPlayback, stop};
}
