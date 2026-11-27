/** Companion backend-PCM audio controller for muted speed-preview clip playback.
 *
 * Keeps `soundAuditionContext()` and `audioPreview` on the `timeline` tab 100%
 * untouched while letting muted constant/curve/reverse speed-clip playback in
 * the `source` tab audition the backend-rendered PCM (keep-pitch in 2×–4×,
 * pitch-shift elsewhere, reversed audio for reverse clips, silent for freeze).
 */
import {useCallback, useEffect, useRef} from 'react';
import {createContinuousAudioPreviewController} from '../timeline-audio-continuous-controller.ts';
import type {TimelineAudioPreviewContext} from '../use-timeline-audio-preview.ts';
import type {NativeAudioPreviewAdmission} from '../native-audio-preview-adapter.ts';

export interface UseSpeedPreviewAudioOptions {
  readonly enabled: boolean;
  readonly context: TimelineAudioPreviewContext;
  readonly nativeAdmission?: NativeAudioPreviewAdmission;
  readonly getContext: () => TimelineAudioPreviewContext;
  readonly readPlan: (input: Record<string, unknown>, options?: {readonly signal?: AbortSignal}) => Promise<unknown>;
  readonly readContinuousPlan: (input: Record<string, unknown>, options?: {readonly signal?: AbortSignal}) => Promise<unknown>;
}

export interface SpeedPreviewAudioCompanion {
  readonly syncPlayback: (state: {readonly playing: boolean; readonly frame: number; readonly silent: boolean}) =>
    Promise<(() => number | null) | undefined>;
  readonly stop: () => void;
}

export function useSpeedPreviewAudio(options: UseSpeedPreviewAudioOptions): SpeedPreviewAudioCompanion {
  const {enabled, context, nativeAdmission, getContext, readPlan, readContinuousPlan} = options;
  const controllerRef = useRef<ReturnType<typeof createContinuousAudioPreviewController> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  const readPlanRef = useRef(readPlan);
  readPlanRef.current = readPlan;
  const readContinuousPlanRef = useRef(readContinuousPlan);
  readContinuousPlanRef.current = readContinuousPlan;
  const playEpochRef = useRef(0);
  const retirementWaiter = useRef<(() => void) | null>(null);
  const releaseRetirementWaiter = useCallback(() => {
    const release = retirementWaiter.current;
    retirementWaiter.current = null;
    release?.();
  }, []);

  useEffect(() => {
    if (!enabled) {
      playEpochRef.current += 1;
      releaseRetirementWaiter();
      controllerRef.current?.dispose();
      controllerRef.current = null;
      return;
    }
    if (!controllerRef.current) {
      controllerRef.current = createContinuousAudioPreviewController({
        readPlan: (input, opts) => readPlanRef.current(input as unknown as Record<string, unknown>, opts),
        readContinuousPlan: (input, opts) => readContinuousPlanRef.current(input as unknown as Record<string, unknown>, opts),
        getContext: () => getContextRef.current(),
        nativeAdmission,
        onChange: state => {if (state.retirement !== 'closing') releaseRetirementWaiter();},
      });
    }
    controllerRef.current.setContext(context);
  }, [
    enabled,
    nativeAdmission,
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
    releaseRetirementWaiter,
  ]);

  useEffect(() => () => {
    playEpochRef.current += 1;
    releaseRetirementWaiter();
    controllerRef.current?.dispose();
    controllerRef.current = null;
  }, [releaseRetirementWaiter]);

  const stop = useCallback(() => {
    playEpochRef.current += 1;
    releaseRetirementWaiter();
    controllerRef.current?.revoke();
  }, [releaseRetirementWaiter]);

  const syncPlayback = useCallback(async (state: {readonly playing: boolean; readonly frame: number; readonly silent: boolean}) => {
    const controller = controllerRef.current;
    if (!enabledRef.current || !controller) return;
    const epoch = ++playEpochRef.current;
    releaseRetirementWaiter();
    if (!state.playing || state.silent) {
      controller.revoke();
      return;
    }
    // Pause revokes immediately, but its PCM request can still own resources.
    // A quick replay waits for that ownership to settle before starting sound.
    if (controller.getState().retirement === 'closing') {
      await new Promise<void>(resolve => {retirementWaiter.current = resolve;});
      if (playEpochRef.current !== epoch || !enabledRef.current) return;
    }
    const ctx = getContextRef.current();
    controller.setContext(ctx);
    if (!ctx.connected || !ctx.visible || ctx.durationFrames <= 0) return;
    const frame = Math.max(0, Math.min(ctx.durationFrames - 1, Math.round(state.frame)));
    try {
      const prepared = await controller.prepare(frame, ctx);
      if (prepared && playEpochRef.current === epoch && enabledRef.current && await controller.play(ctx)) {
        return () => playEpochRef.current === epoch ? controller.readOutputSample() : null;
      }
    } catch {
      // The picture can still play if this source has no usable audio.
    }
  }, [releaseRetirementWaiter]);

  return {syncPlayback, stop};
}
