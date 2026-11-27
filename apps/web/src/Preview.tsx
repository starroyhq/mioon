import './preview-editing.css';
import PreviewPlaybackControls from './PreviewPlaybackControls.tsx';
import PreviewRenderProgress from './PreviewRenderProgress.tsx';
import { aspectFrameFormatLabel, AspectFrameFeedback, AspectFrameMenu, AspectFrameSuggestion, type AspectFrameView } from './AspectFrameControls.tsx';
import {stepPreviewMedia} from './preview-playback.ts';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {Film, Headphones, ChevronDown, AudioLines} from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import { statusDescriptor, safeTaskErrorCode } from './creation-i18n.ts';
import TimelineAudioPreview from './TimelineAudioPreview.tsx';
import ClipTransformBox, { type PreviewTransformBox } from './ClipTransformBox.tsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Button } from '@mioon/ui/components/button';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import Icon from './icons.tsx';
import {useProjectMediaReadGate} from './project-media-read-gate.tsx';
import {MediaStatusBadge, MediaStatusNote} from './project-file/MediaStatus.tsx';
import { disposeMedia } from './Nodes.tsx';
import { assetUrl, mediaUrl } from './api.ts';
import { assetKind } from './Timeline.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { exportHistoryDelivery, exportHistoryPicture, previewMatchesTimeline } from './export-settings-state.ts';
import { sourceFrameCount, sourcePositionFrame, sourceSeekMatchesTime, SOURCE_RANGE_FPS } from './source-range-state.ts';
import type { AppAsset, AppTimeline, AppTimelineClip } from './App.tsx';
import type { TimelineAudioPreviewView } from './use-timeline-audio-preview.ts';
import type {MenuPlaybackControl} from './desktop-menu-client.ts';
import type {TimelinePlaybackClock} from './timeline-playback-clock.ts';
import type {ClipSpeedPreviewBinding} from './speed-preview/speed-preview-model.ts';

type Translate = ReturnType<typeof useI18n>['t'];
export interface PreviewCaptureIntent {readonly sourceScope: string; readonly sourceAssetId: string; readonly sourceHash: string; readonly sourceFrame: number}
export interface PreviewSeek {scope?: string | null; id: number | string; frame: number}
export interface PreviewRenderJobView {
  id?: string; projectId?: string | null; status: string; url?: string | null; assetId?: string | null; timelineRevision?: number | null;
  purpose?: string; progress?: number; error?: unknown; providerId?: string;
  snapshot?: {timeline?: {id?: string; revision?: number; fps?: number; durationFrames?: number; width?: number; height?: number} | null} | null;
  [key: string]: unknown;
}
interface SourceFrameCaptureControlProps {
  captureKey: string; inspect: () => PreviewCaptureIntent | null; subscribe: (update: () => void) => () => void;
  onCaptureFrame: (intent: PreviewCaptureIntent) => unknown; captureBusy: boolean;
}
interface CaptureToken {captureKey: string; inspect: () => PreviewCaptureIntent | null; onCaptureFrame: (intent: PreviewCaptureIntent) => unknown; captureBusy: boolean}
interface ReadyCapture {key: string; intent: PreviewCaptureIntent | null}
interface MediaBinding {
  element: HTMLMediaElement; key: string; url: string; programmaticSeek: number | null; sourceSeekIntent: number | null;
  pendingSourceSeek: {scope?: string | null; id: number | string} | null; lastSeekRequest: string | number | null;
}
interface CaptureContext {key: string; visible: boolean; busy: boolean; scope?: string | null}
interface SourceState {scope?: string | null; position: number; request: PreviewSeek | null}
export interface PreviewProps {
  onRegisterMenuPlayback?: (control: MenuPlaybackControl) => () => void;
  onMenuStateChange?: () => void;
  onBeforePlay?: () => unknown;
  audioPreview?: TimelineAudioPreviewView | null;
  onRegisterMediaPause?: (pause: () => void) => unknown;
  visible?: boolean;
  kind: string;
  onKind: (kind: string) => unknown;
  asset?: AppAsset | null;
  clip?: AppTimelineClip | null;
  timeline?: AppTimeline | null;
  job?: PreviewRenderJobView | null;
  pendingJob?: PreviewRenderJobView | null;
  playhead: number;
  onSeek: (frame: number) => unknown;
  playbackClock?: TimelinePlaybackClock;
  onPlaybackCommit?: (frame: number) => void;
  sourceScope?: string | null;
  sourcePosition?: number;
  sourceSeek?: PreviewSeek | null;
  onSourcePosition?: (frame: number, scope?: string | null) => unknown;
  onRender: (purpose: string) => unknown;
  busy?: boolean;
  onCanvas?: () => unknown;
  onImport?: () => unknown;
  onSeed?: () => unknown;
  canSeed?: boolean;
  seedBusy?: boolean;
  onCaptureFrame?: (intent: PreviewCaptureIntent) => unknown;
  captureBusy?: boolean;
  /** Opens shot detection for the source video; the reason disables it when set. */
  onDetectScenes?: () => unknown;
  sceneDetectIssue?: import('../../../packages/i18n/src/index.ts').DisplayMessage | null;
  /** The selected visual clip's transform box over the rendered timeline preview. */
  transformBox?: PreviewTransformBox | null;
  /** SP-V: active clip speed-preview binding (`null`/absent when `capabilities.speed !== true`). */
  speedPreview?: ClipSpeedPreviewBinding | null;
  aspectFrame?: AspectFrameView;
}

// Media readiness belongs to the rendered binding. A retained click handler
// always asks the current player again; its displayed enabled state is advisory.
export function SourceFrameCaptureControl({ captureKey, inspect, subscribe, onCaptureFrame, captureBusy }: SourceFrameCaptureControlProps) {
  const { t } = useI18n();
  const [ready, setReady] = useState<ReadyCapture | null>(null), [submitting, setSubmitting] = useState(false);
  const live = useRef<CaptureToken | null>(null), inFlight = useRef(false);
  useLayoutEffect(() => {
    const token: CaptureToken = { captureKey, inspect, onCaptureFrame, captureBusy };
    live.current = token;
    const update = () => {
      if (live.current !== token) return;
      const intent = inspect();
      setReady(previous => previous?.key === captureKey && previous?.intent?.sourceFrame === intent?.sourceFrame && Boolean(previous?.intent) === Boolean(intent) ? previous : { key: captureKey, intent });
    };
    const unsubscribe = subscribe(update); update();
    return () => { if (live.current === token) live.current = null; unsubscribe(); };
  }, [captureKey, inspect, subscribe, onCaptureFrame, captureBusy]);
  async function capture(): Promise<void> {
    const token = live.current;
    if (!token || token.captureKey !== captureKey || token.captureBusy || inFlight.current) return;
    const intent = token.inspect();
    if (!intent) return;
    inFlight.current = true; setSubmitting(true);
    try { await token.onCaptureFrame(intent); }
    finally { inFlight.current = false; if (live.current) setSubmitting(false); }
  }
  return <div className="source-frame-capture"><Button type="button" variant="outline" size="sm" data-testid="source-frame-capture" disabled={captureBusy || submitting || ready?.key !== captureKey || !ready?.intent} onClick={capture}>{t('timeline.preview.capture')}</Button></div>;
}

function PlaybackPosition({ clock, fallback, render }: {
  clock: TimelinePlaybackClock; fallback: number; render: (frame: number) => React.ReactElement;
}): React.ReactElement {
  const frame = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  return render(frame ?? fallback);
}

export default function Preview({ onRegisterMenuPlayback, onMenuStateChange, onBeforePlay, audioPreview, onRegisterMediaPause, visible = true, kind, onKind, asset, clip, timeline, job, pendingJob, playhead, onSeek, playbackClock, onPlaybackCommit, sourceScope, sourcePosition = 0, sourceSeek, onSourcePosition, onRender, busy, onCanvas, onImport, onSeed, canSeed = false, seedBusy = false, onCaptureFrame, captureBusy = false, onDetectScenes, sceneDetectIssue = null, transformBox = null, speedPreview = null, aspectFrame }: PreviewProps): React.ReactElement {
  const { t, renderMessage } = useI18n();
  const {preferences} = useUiPreferences();
  const media = useRef<HTMLMediaElement | null>(null);
  const ancestorVisible = useWorkspaceVisibility();
  visible = visible && ancestorVisible;
  const visibleRef = useRef<boolean>(visible);
  const rendered = kind === 'timeline';
  const activeSpeedPreview = !rendered && clip ? (speedPreview ?? null) : null;
  const speedPreviewRef = useRef<ClipSpeedPreviewBinding | null>(activeSpeedPreview);
  speedPreviewRef.current = activeSpeedPreview;
  const frameListeners = useRef<Set<() => void>>(new Set());
  const notifyFramePlayback = () => { for (const listener of frameListeners.current) listener(); };
  const frameLoop = useRef<{raf: number | null; token: object; startMs: number; startFrame: number; lastFrame: number} | null>(null);
  const nativeTicker = useRef<number | null>(null);
  const nativeAudioActive = useRef<boolean>(false);
  const timelineClock = rendered || clip ? playbackClock : undefined;
  const ready = Boolean(job && ['succeeded','completed','ready'].includes(job.status) && (job.url || job.assetId));
  const stale = Boolean(ready && !previewMatchesTimeline(job, timeline));
  const frozenTimeline = rendered && ready ? job?.snapshot?.timeline : null;
  const playbackDuration = frozenTimeline?.durationFrames ?? timeline?.durationFrames;
  const playbackFps = frozenTimeline?.fps || timeline?.fps || SOURCE_RANGE_FPS;
  const playbackFrame = (frame: number) => Math.max(0, Math.min(playbackDuration ?? frame, frame));

  const gate = useProjectMediaReadGate();
  const readIdentity = rendered ? {id: job?.assetId, projectId: job?.projectId} : asset;
  const blocked = Boolean(gate && (rendered ? ready : asset) && !gate.canRead(readIdentity));
  const url = blocked ? '' : rendered ? ready ? mediaUrl(job!.projectId, job!.assetId) : '' : activeSpeedPreview ? activeSpeedPreview.mediaUrl : assetUrl(asset);
  const type: string = rendered ? 'video' : assetKind(asset);
  const mediaKey = `${kind}:${type}:${url}:${rendered ? job?.id || job?.timelineRevision : asset?.id || ''}:${clip?.id || ''}:${!rendered && !clip ? sourceScope || '' : ''}:${!rendered ? asset?.sha256 || '' : ''}${activeSpeedPreview ? `:${activeSpeedPreview.mediaKey}` : ''}`;
  const activeMedia = useRef<MediaBinding | null>(null);
  const appliedSourceSeek = useRef<{scope?: string | null; id: number | string} | null>(null);
  const sourceRequest = sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek : null;
  const currentSource = useRef<SourceState>({ scope: sourceScope, position: sourcePosition, request: null });
  currentSource.current = { scope: sourceScope, position: sourcePosition, request: sourceRequest };
  const captureObserver = useRef<(() => void) | null>(null), captureContext = useRef<CaptureContext>({ key: '', visible, busy: captureBusy, scope: sourceScope });
  const captureKey = `${mediaKey}:${asset?.sha256 || ''}`;
  captureContext.current = { key: captureKey, visible, busy: captureBusy, scope: sourceScope };
  const timelineSeconds = (frame: number) => rendered ? playbackFrame(frame) / playbackFps
    : activeSpeedPreview ? activeSpeedPreview.outputFrameToMediaSeconds(frame)
    : clip ? ((clip.sourceInFrame || 0) + Math.max(0, Math.min(clip.durationFrames, frame - clip.startFrame))) / SOURCE_RANGE_FPS : null;
  const sourceSeconds = timelineSeconds(playhead);
  const seekRequest = !rendered && !clip ? `${sourceScope || ''}:${sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek.id : 'initial'}` : sourceSeconds;
  function stopNativeTicker(): void {
    if (nativeTicker.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(nativeTicker.current);
    nativeTicker.current = null;
  }
  function applySpeedPlaybackRate(element: HTMLMediaElement | null): void {
    if (!element) return;
    const speed = speedPreviewRef.current;
    if (speed) {
      const rate = speed.frameDrivenPlayback ? 1 : speed.playbackRate;
      try {
        if (element.defaultPlaybackRate !== rate) element.defaultPlaybackRate = rate;
        if (element.playbackRate !== rate) element.playbackRate = rate;
        if (speed.muteVideo && !element.muted) element.muted = true;
      } catch { /* Non-standard media element host. */ }
    } else if (typeof element.playbackRate === 'number' && element.playbackRate !== 1) {
      try {
        element.defaultPlaybackRate = 1;
        element.playbackRate = 1;
      } catch { /* Ignore. */ }
    }
  }
  function stopFramePlayback(commit: boolean): void {
    const loop = frameLoop.current;
    if (!loop) return;
    frameLoop.current = null;
    if (loop.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(loop.raf);
    notifyFramePlayback();
    const stopped = timelineClock?.stop(loop.token);
    const binding = activeMedia.current;
    const currentSpeed = speedPreviewRef.current;
    currentSpeed?.onPlaybackStateChange?.({ playing: false, frame: loop.lastFrame, silent: currentSpeed.silent });
    if (commit && stopped && binding) {
      commitNativeFrame(binding, loop.lastFrame);
    }
  }
  function toggleFramePlayback(): void {
    const currentSpeed = speedPreviewRef.current;
    const element = media.current;
    if (!currentSpeed?.frameDrivenPlayback || !element || !isCurrentMedia(element) || element.readyState < 1) return;
    if (frameLoop.current) { stopFramePlayback(true); return; }
    onBeforePlay?.();
    audioPreview?.controller.revoke();
    element.pause();
    const clipEnd = currentSpeed.clipStartFrame + currentSpeed.clipDurationFrames;
    const currentFrame = timelineClock?.getSnapshot() ?? playhead;
    const startFrame = currentFrame >= clipEnd || currentFrame < currentSpeed.clipStartFrame
      ? currentSpeed.clipStartFrame
      : Math.round(currentFrame);
    const token = {};
    const loop = { raf: null as number | null, token, startMs: typeof performance !== 'undefined' ? performance.now() : Date.now(), startFrame, lastFrame: startFrame };
    frameLoop.current = loop;
    notifyFramePlayback();
    timelineClock?.start(token, startFrame);
    seekMedia(element, false, startFrame);
    currentSpeed.onPlaybackStateChange?.({ playing: true, frame: startFrame, silent: currentSpeed.silent });
    const step = () => {
      if (frameLoop.current !== loop) return;
      const liveSpeed = speedPreviewRef.current;
      const el = media.current;
      if (!liveSpeed?.frameDrivenPlayback || !el || !isCurrentMedia(el)) { stopFramePlayback(false); return; }
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsedFrames = Math.floor(Math.max(0, nowMs - loop.startMs) / 1000 * liveSpeed.fps);
      const nextFrame = Math.min(liveSpeed.clipStartFrame + liveSpeed.clipDurationFrames, loop.startFrame + elapsedFrames);
      if (nextFrame !== loop.lastFrame) {
        loop.lastFrame = nextFrame;
        timelineClock?.tick(token, nextFrame);
        if (!liveSpeed.silent && !el.seeking) {
          const target = liveSpeed.outputFrameToMediaSeconds(nextFrame);
          const max = Number.isFinite(el.duration) ? Math.max(0, el.duration - .001) : target;
          const clamped = Math.max(0, Math.min(target, max));
          if (Math.abs(el.currentTime - clamped) > .005 && activeMedia.current) {
            activeMedia.current.programmaticSeek = clamped;
            el.currentTime = clamped;
          }
        }
      }
      if (nextFrame >= liveSpeed.clipStartFrame + liveSpeed.clipDurationFrames) {
        stopFramePlayback(true);
        return;
      }
      loop.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(step) : null;
    };
    loop.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(step) : null;
  }
  const pauseCurrent = useRef<() => void>(() => {});
  pauseCurrent.current = () => {
    stopFramePlayback(true);
    stopNativeTicker();
    const binding = activeMedia.current;
    if (!binding || binding.element !== media.current) return;
    binding.element.pause();
    settlePlayback(binding);
  };
  useLayoutEffect(() => {
    const unregister = onRegisterMediaPause?.(() => pauseCurrent.current());
    if (typeof unregister === 'function') return () => { unregister(); };
  }, [onRegisterMediaPause]);
  useLayoutEffect(() => {
    const element = media.current;
    if (!element) return;
    const binding = { element, key: mediaKey, url, programmaticSeek: null, sourceSeekIntent: null, pendingSourceSeek: null, lastSeekRequest: null };
    activeMedia.current = binding;
    // Restore src when development Strict Mode replays the cleanup/setup pair.
    if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    applySpeedPlaybackRate(element);
    captureObserver.current?.();
    return () => {
      stopFramePlayback(false);
      stopNativeTicker();
      if (activeMedia.current === binding) activeMedia.current = null;
      settlePlayback(binding);
      disposeMedia(element);
    };
  }, [mediaKey, timelineClock]);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) pauseCurrent.current();
    captureObserver.current?.();
  }, [visible, mediaKey]);
  useLayoutEffect(() => {
    applySpeedPlaybackRate(media.current);
    if (!activeSpeedPreview?.frameDrivenPlayback) stopFramePlayback(false);
  }, [mediaKey, activeSpeedPreview?.playbackRate, activeSpeedPreview?.frameDrivenPlayback, activeSpeedPreview?.muteVideo]);
  function isCurrentMedia(element: HTMLMediaElement | null): boolean {
    const active = activeMedia.current;
    return Boolean((!gate || gate.canRead(readIdentity)) && visibleRef.current && element && element.isConnected && element === media.current && active !== null && active.element === element && active.key === mediaKey && active.url === url && element.getAttribute('src') === url);
  }
  function inspectCapture() {
    const element = media.current, binding = activeMedia.current, current = captureContext.current;
    if (!element || !binding || !current) return null;
    if (kind !== 'source' || clip || type !== 'video' || !onCaptureFrame || !sourceScope || current?.key !== captureKey || current.scope !== sourceScope || !current.visible || current.busy || !isCurrentMedia(element) || !element.paused || element.seeking || element.readyState < 2 || !Number.isFinite(element.currentTime) || element.currentTime < 0 || binding.pendingSourceSeek || binding.programmaticSeek !== null) return null;
    const request = currentSource.current.request;
    const acknowledged = request && appliedSourceSeek.current?.scope === sourceScope && appliedSourceSeek.current?.id === request.id;
    if (request && !acknowledged) return null;
    const count = sourceFrameCount(asset?.duration);
    if (count === null || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) return null;
    const intent = acknowledged && binding.sourceSeekIntent === request?.frame && sourceSeekMatchesTime(element.currentTime, request!.frame) ? request!.frame : null;
    const sourceFrame = sourcePositionFrame(element.currentTime, count, intent);
    if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0 || sourceFrame >= count) return null;
    return Object.freeze({ sourceScope: sourceScope as string, sourceAssetId: asset.id, sourceHash: asset.sha256 as string, sourceFrame });
  }
  function subscribeCapture(update: () => void): () => void {
    captureObserver.current = update;
    return () => { if (captureObserver.current === update) captureObserver.current = null; };
  }
  function updateCapture(event: React.SyntheticEvent<HTMLMediaElement>): void {
    if (isCurrentMedia(event.currentTarget)) captureObserver.current?.();
  }
  function seekMedia(element: HTMLMediaElement | null, loadedMetadata = false, explicitFrame?: number): void {
    if (!isCurrentMedia(element) || !element) return;
    applySpeedPlaybackRate(element);
    const standaloneSource = !rendered && !clip;
    if (standaloneSource && element.readyState < 1) return;
    const source = currentSource.current, request = source.request;
    const newSourceRequest = request && (appliedSourceSeek.current?.scope !== source.scope || appliedSourceSeek.current?.id !== request.id);
    const sourceFrame = newSourceRequest ? request!.frame : source.position;
    const targetSeconds = standaloneSource ? sourceFrame / SOURCE_RANGE_FPS
      : (explicitFrame === undefined ? sourceSeconds : timelineSeconds(explicitFrame)) as number;
    if (!Number.isFinite(targetSeconds)) return;
    const binding = activeMedia.current;
    if (!binding) return;
    const currentSeekRequest = standaloneSource ? `${source.scope || ''}:${request?.id ?? 'initial'}` : targetSeconds;
    // Reopening alone preserves native playback position. A changed playhead or
    // source while hidden still applies its deferred seek when shown again.
    if (!loadedMetadata && explicitFrame === undefined && binding.lastSeekRequest === currentSeekRequest) {
      if (standaloneSource && binding.pendingSourceSeek) publishSourcePosition(element);
      return;
    }
    binding.lastSeekRequest = currentSeekRequest;
    if (standaloneSource) {
      binding.sourceSeekIntent = sourceFrame;
      // A currentTime assignment is not confirmation: metadata or seeked may
      // still be pending across rerenders, tab changes, or a hidden player.
      binding.pendingSourceSeek = newSourceRequest ? { scope: source.scope, id: request!.id } : null;
    }
    const max = Number.isFinite(element.duration) ? Math.max(0, element.duration - (!rendered && !clip ? 0 : .001)) : targetSeconds;
    const seconds = Math.max(0, Math.min(targetSeconds, max));
    if (Math.abs(element.currentTime - seconds) > (standaloneSource || explicitFrame !== undefined ? 1e-7 : .02)) {
      activeMedia.current!.programmaticSeek = seconds;
      element.currentTime = seconds;
    } else if (!rendered && !clip) publishSourcePosition(element);
    if (explicitFrame !== undefined && !element.paused && !element.ended && activeSpeedPreview && !activeSpeedPreview.frameDrivenPlayback) {
      activeSpeedPreview.onPlaybackStateChange?.({ playing: true, frame: explicitFrame, silent: activeSpeedPreview.silent });
    }
    captureObserver.current?.();
  }
  useEffect(() => { seekMedia(media.current); }, [playhead, mediaKey, visible, clip?.sourceInFrame, clip?.startFrame, clip?.durationFrames, seekRequest]);
  const seekCurrent = useRef<(frame: number) => void>(() => {});
  seekCurrent.current = frame => { if (frameLoop.current) stopFramePlayback(false); seekMedia(media.current, false, frame); };
  useLayoutEffect(() => {
    if (!timelineClock) return;
    let revision = timelineClock.getSeekRevision();
    return timelineClock.subscribe(() => {
      const next = timelineClock.getSeekRevision();
      if (next === revision) return;
      revision = next;
      const frame = timelineClock.getSeekFrame();
      if (frame !== null) seekCurrent.current(frame);
    });
  }, [mediaKey, timelineClock]);

  function timelineFrame(element: HTMLMediaElement): number {
    if (rendered) return playbackFrame(Math.round(element.currentTime * playbackFps));
    if (activeSpeedPreview) return activeSpeedPreview.mediaSecondsToOutputFrame(element.currentTime);
    const frame = Math.round(element.currentTime * SOURCE_RANGE_FPS);
    const local = frame - (clip?.sourceInFrame || 0);
    return clip ? clip.startFrame + Math.max(0, Math.min(clip.durationFrames, local)) : frame;
  }
  function commitNativeFrame(binding: MediaBinding, frame: number): void {
    if (!Number.isSafeInteger(frame)) return;
    binding.lastSeekRequest = timelineSeconds(frame);
    (onPlaybackCommit ?? onSeek)(frame);
  }
  function settlePlayback(binding: MediaBinding): void {
    stopNativeTicker();
    const currentSpeed = speedPreviewRef.current;
    if (nativeAudioActive.current) {
      nativeAudioActive.current = false;
      currentSpeed?.onPlaybackStateChange?.({ playing: false, frame: timelineFrame(binding.element), silent: currentSpeed.silent });
    }
    if (!timelineClock?.stop(binding)) return;
    // An explicit seek is already saved by its caller. While that assignment is
    // being resolved, the media element may still report the previous frame.
    if (!binding.element.seeking || binding.programmaticSeek === null) {
      commitNativeFrame(binding, timelineFrame(binding.element));
    }
  }
  function startTimelinePlayback(element: HTMLMediaElement): void {
    applySpeedPlaybackRate(element);
    if (timelineClock && !element.paused && !element.ended && element.readyState >= 1) {
      const binding = activeMedia.current!;
      const currentSpeed = speedPreviewRef.current;
      let startFrame = timelineFrame(element);
      if (currentSpeed && !currentSpeed.frameDrivenPlayback) {
        const clipEnd = currentSpeed.clipStartFrame + currentSpeed.clipDurationFrames;
        if (startFrame >= clipEnd) {
          startFrame = currentSpeed.clipStartFrame;
          const resetSec = currentSpeed.outputFrameToMediaSeconds(startFrame);
          binding.programmaticSeek = resetSec;
          element.currentTime = resetSec;
        }
      }
      timelineClock.start(binding, startFrame);
      if (currentSpeed && !currentSpeed.frameDrivenPlayback) {
        if (!nativeAudioActive.current) {
          nativeAudioActive.current = true;
          currentSpeed.onPlaybackStateChange?.({ playing: true, frame: startFrame, silent: currentSpeed.silent });
        }
        stopNativeTicker();
        const tickNative = () => {
          const el = media.current;
          if (!el || el.paused || el.ended || activeMedia.current !== binding || !isCurrentMedia(el)) {
            nativeTicker.current = null;
            return;
          }
          const frame = timelineFrame(el);
          timelineClock.tick(binding, frame);
          if (clip && !rendered && frame >= clip.startFrame + clip.durationFrames) {
            const liveSpeed = speedPreviewRef.current;
            if (liveSpeed) {
              const clampSec = liveSpeed.outputFrameToMediaSeconds(clip.startFrame + clip.durationFrames);
              const maxSec = Number.isFinite(el.duration) ? Math.max(0, el.duration - .001) : clampSec;
              const target = Math.max(0, Math.min(clampSec, maxSec));
              if (Math.abs(el.currentTime - target) > .02) {
                binding.programmaticSeek = target;
                el.currentTime = target;
              }
            }
            pauseCurrent.current();
            return;
          }
          nativeTicker.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tickNative) : null;
        };
        nativeTicker.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tickNative) : null;
      }
    }
  }

  function guardPlayback(event: React.SyntheticEvent<HTMLMediaElement>): void {
    const element = event.currentTarget;
    if (!isCurrentMedia(element)) { element.pause(); return; }
    onBeforePlay?.();
    audioPreview?.controller.revoke();
    if (!element.seeking) activeMedia.current!.programmaticSeek = null;
    startTimelinePlayback(element);
    captureObserver.current?.();
  }
  function finishSeek(event: React.SyntheticEvent<HTMLMediaElement>): void {
    const element = event.currentTarget;
    if (!isCurrentMedia(element) || element.seeking) return;
    const binding = activeMedia.current;
    if (!binding) return;
    const programmed = binding.programmaticSeek;
    binding.programmaticSeek = null;
    // Restoring the source's clamped display position must not rewrite the
    // independently saved timeline playhead. Native paused scrubbing still can.
    if (programmed !== null && Math.abs(element.currentTime - programmed) < .05) {
      if (!rendered && !clip) publishSourcePosition(element);
      else if (!element.paused) timelineClock?.tick(binding, timelineFrame(element));
      captureObserver.current?.();
      return;
    }
    updateTime(event, true);
    captureObserver.current?.();
  }
  function publishSourcePosition(element: HTMLMediaElement | null): void {
    if (!isCurrentMedia(element) || !element || element.seeking || element.readyState < 1) return;
    const binding = activeMedia.current;
    if (!binding) return;
    // A stable native position acknowledges the applied intent, including a
    // later native scrub that deliberately supersedes its target.
    if (binding.pendingSourceSeek) {
      appliedSourceSeek.current = binding.pendingSourceSeek;
      binding.pendingSourceSeek = null;
    }
    if (!sourceSeekMatchesTime(element.currentTime, binding.sourceSeekIntent)) binding.sourceSeekIntent = null;
    onSourcePosition?.(sourcePositionFrame(element.currentTime, sourceFrameCount(asset?.duration), binding.sourceSeekIntent), currentSource.current.scope);
    captureObserver.current?.();
  }
  function pauseMedia(event: React.SyntheticEvent<HTMLMediaElement>): void {
    // Native pause may land between periodic timeupdate events. Mark controls
    // must see the paused source position, even when the last tick was older.
    const element = event.currentTarget;
    if (!rendered && !clip) publishSourcePosition(element);
    else if (isCurrentMedia(element) && (element.paused || element.ended)) settlePlayback(activeMedia.current!);
    updateCapture(event);
  }
  function updateTime(event: React.SyntheticEvent<HTMLMediaElement>, nativeSeek = false): void {
    const element = event.currentTarget;
    if (!isCurrentMedia(element)) { if (!visibleRef.current) element.pause(); return; }
    if (!nativeSeek && (element.paused || element.seeking || activeMedia.current!.programmaticSeek !== null)) return;
    if (!rendered && !clip) { publishSourcePosition(element); return; }
    const binding = activeMedia.current!;
    const frame = timelineFrame(element);
    if (timelineClock) {
      if (nativeSeek && element.paused) {
        timelineClock.stop(binding);
        commitNativeFrame(binding, frame);
      } else timelineClock.tick(binding, frame);
    } else onSeek(frame);
    if (clip && !rendered && frame >= clip.startFrame + clip.durationFrames) pauseCurrent.current();
  }
  const deliveredArtifact = rendered && job?.purpose === 'export';
  const delivery = exportHistoryDelivery(job), frozenPicture = rendered && ready ? exportHistoryPicture(job) : null;
  const inProgress = Boolean(pendingJob && ['queued','running','pending','submitting'].includes(pendingJob.status));
  const cancelledExport = pendingJob?.status === 'failed' && safeTaskErrorCode(pendingJob.error) === 'EXPORT_CANCELLED';
  const displayFormat = (rendered && ready ? frozenTimeline : rendered || type === 'audio' ? timeline : asset) as {width?: number; height?: number; fps?: number; durationFrames?: number} | null | undefined;
  const formatLabel = frozenPicture ? t('redesign.export.frozenPictureFormat', frozenPicture)
    : rendered && ready && Object.hasOwn(job?.snapshot ?? {}, 'delivery') ? t('timeline.preview.formatUnavailable')
    : displayFormat?.width && displayFormat?.height ? `${displayFormat.width} × ${displayFormat.height} · ${displayFormat.fps || timeline?.fps || 30} fps`
    : !rendered && type === 'audio' ? '' : t('timeline.preview.formatUnavailable');
  const frameLabel = aspectFrame ? aspectFrameFormatLabel(aspectFrame) ?? formatLabel : formatLabel;
  const previewMetadata = rendered ? ready ? [
    renderMessage(statusDescriptor(job!.status)), formatLabel, delivery && renderMessage(delivery.rateMessage),
  ].filter(Boolean).join(' · ') : t('timeline.preview.persistent') : clip ? t('timeline.preview.clipPosition',{start:clip.startFrame,source:clip.sourceInFrame??0,duration:clip.durationFrames}) : t('timeline.preview.independent');
  function stepPreview(delta: number): void {
    if (frameLoop.current) stopFramePlayback(false);
    const element = media.current, binding = activeMedia.current;
    const current = isCurrentMedia(element);
    // A step starts at the current native frame when playback is in progress.
    const position = timelineClock?.getSnapshot() != null && current && element
      ? (activeSpeedPreview?.frameDrivenPlayback ? timelineClock.getSnapshot()! : timelineFrame(element)) : rendered ? playbackFrame(playhead) : playhead;
    stepPreviewMedia({
      delta, media: element, current, timelineMode: rendered || Boolean(clip), timelineDuration: playbackDuration ?? 0,
      playhead: position, sourcePosition, sourceCount: sourceFrameCount(asset?.duration), sourceFps: SOURCE_RANGE_FPS,
      binding, onSeek: frame => {
        // The explicit position is authoritative over the queued native pause.
        if (binding) timelineClock?.stop(binding);
        onSeek(frame);
      }, notify: () => captureObserver.current?.(),
    });
  }
  const withPlaybackPosition = (render: (frame: number) => React.ReactElement) =>
    timelineClock ? <PlaybackPosition clock={timelineClock} fallback={playhead} render={render} /> : render(playhead);
  const getMedia = () => media.current;
  const renderPlaybackControls = (frame: number) => <PreviewPlaybackControls
    onRegisterMenuPlayback={onRegisterMenuPlayback} onMenuStateChange={onMenuStateChange}
    bindingKey={`${mediaKey}:${visible}`} getMedia={getMedia} isCurrent={isCurrentMedia}
    position={!rendered && !clip ? sourcePosition : rendered ? playbackFrame(frame) : frame}
    duration={!rendered && !clip ? sourceFrameCount(asset?.duration) || 0 : playbackDuration ?? 0}
    fps={playbackFps} format={preferences.timecodeFormat} standaloneSource={!rendered && !clip}
    onStep={stepPreview} metadata={previewMetadata}
    {...(activeSpeedPreview?.frameDrivenPlayback ? { customPlayback: { isPlaying: () => Boolean(frameLoop.current), subscribe: (listener: () => void) => { frameListeners.current.add(listener); return () => { frameListeners.current.delete(listener); }; }, toggle: toggleFramePlayback } } : {})} />;

  return <Tabs value={kind} onValueChange={onKind} className={`central-preview edit-preview ${visible ? '' : 'workspace-hidden'}`} aria-label={t('timeline.preview.main')} data-testid="central-preview">
    <div className="preview-mode-bar">
      <h2 className="sr-only">{t('timeline.preview.title')}</h2>
      <TabsList className="segmented" aria-label={t('timeline.preview.mode')}>
        <TabsTrigger value="source" className={!rendered ? 'active' : ''} data-testid="preview-source-mode">{t('edit.preview.sourceTab')}</TabsTrigger>
        <TabsTrigger value="timeline" className={rendered ? 'active' : ''} data-testid="preview-timeline-mode">{t('edit.preview.timelineTab')}</TabsTrigger>
      </TabsList>
      <span className="edit-preview-format" title={aspectFrame && !(rendered && ready) ? frameLabel : previewMetadata}>{frameLabel}</span>
      {aspectFrame && <AspectFrameMenu {...aspectFrame} />}
    </div>
    {aspectFrame && <AspectFrameFeedback {...aspectFrame} />}
    {rendered && stale && <div className="preview-notice stale" data-testid="preview-stale"><Icon name="info" size={15} /><span>{t('timeline.preview.stale', { rendered: job!.timelineRevision ?? 0, current: timeline?.revision ?? '—' })}</span><Button variant="ghost" disabled={busy || inProgress} onClick={() => onRender('preview')}>{t('timeline.preview.update')}</Button></div>}
    {rendered && inProgress && <PreviewRenderProgress revision={pendingJob?.timelineRevision ?? 0} previous={Boolean(ready)} progress={pendingJob?.progress} />}
    {rendered && pendingJob?.status === 'failed' && <div className="preview-notice stale" role={cancelledExport ? 'status' : 'alert'} data-testid={cancelledExport ? 'preview-export-cancelled' : 'preview-render-failed'}><span>{t(cancelledExport ? 'redesign.export.cancelled' : 'timeline.preview.failed')}{safeTaskErrorCode(pendingJob!.error) && <small>{t('timeline.frame.errorCode', { code: safeTaskErrorCode(pendingJob!.error)! })}</small>}</span><Button variant="ghost" disabled={busy} onClick={() => onRender('preview')}>{t('timeline.preview.rerender')}</Button></div>}
    {rendered && audioPreview && <details className="edit-preview-audio"><summary><Headphones size={14}/><span>{t('audio.preview.title')}</span><ChevronDown size={12}/></summary>{withPlaybackPosition(frame => <TimelineAudioPreview audioPreview={audioPreview} startFrame={frame} />)}</details>}
    <TabsContent value={kind} className={`preview-stage ${type === 'audio' ? 'audio-stage' : ''}`}>
      {blocked && gate ? <div className="preview-placeholder pf-media-blocked" data-testid="preview-media-blocked"><MediaStatusBadge status={gate.statusFor(readIdentity)} /><MediaStatusNote status={gate.statusFor(readIdentity)} /></div> : url ? <>{type === 'image' ? <img className="preview-image" src={url} alt={asset?.name || t('timeline.preview.source')} /> : type === 'audio' ? <div className="audio-preview-art" data-testid="source-audio-card"><AudioLines size={48} aria-hidden="true" /><strong>{asset?.name}</strong><audio ref={media as unknown as React.Ref<HTMLAudioElement>} key={mediaKey} data-testid="source-preview-audio" src={url} preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onEnded={timelineClock ? pauseMedia : undefined} onTimeUpdate={updateTime} onSeeked={finishSeek} /></div> : <video ref={media as unknown as React.Ref<HTMLVideoElement>} key={mediaKey} data-testid={rendered ? 'timeline-preview-video' : 'source-preview-video'} data-speed-preview-mode={activeSpeedPreview?.mode} src={url} muted={activeSpeedPreview?.muteVideo ? true : undefined} playsInline preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onEnded={timelineClock ? pauseMedia : undefined} onTimeUpdate={updateTime} onSeeked={finishSeek} onLoadedData={updateCapture} onCanPlay={updateCapture} onSeeking={updateCapture} onEmptied={updateCapture} />}{rendered && <span className="preview-stage-label">{t('timeline.preview.stage', { kind: t(deliveredArtifact ? 'timeline.preview.final' : 'timeline.preview.editing'), revision: job!.timelineRevision ?? 0, status: t(stale ? 'timeline.preview.expired' : 'timeline.preview.current') })}</span>}{rendered && visible && !stale && job?.purpose === 'preview' && transformBox && timeline && withPlaybackPosition(frame => <ClipTransformBox key={`${mediaKey}:${timeline.revision}:${transformBox.clip.id}`} box={transformBox} playhead={frame} timeline={timeline} media={media} mediaKey={mediaKey} />)}{activeSpeedPreview?.overlay && (activeSpeedPreview.overlay.kind === 'processing' ? <div className="preview-speed-overlay is-processing" data-testid="preview-speed-processing" role="status" aria-live="polite"><div className="preview-speed-overlay-main"><div className="preview-speed-overlay-row"><span className="speed-spinner" aria-hidden="true" /><span>{activeSpeedPreview.overlay.label}</span></div>{activeSpeedPreview.overlay.percent !== null && <div className="preview-speed-overlay-bar"><span style={{ width: `${activeSpeedPreview.overlay.percent}%` }} /></div>}</div></div> : <div className="preview-speed-overlay is-failed" data-testid="preview-speed-failed" role="alert"><div className="preview-speed-overlay-main"><div className="preview-speed-overlay-row"><Icon name="warning" size={14} /><span>{activeSpeedPreview.overlay.message}</span></div></div>{activeSpeedPreview.overlay.canRetry && activeSpeedPreview.onRetryTask && <Button type="button" variant="outline" size="sm" className="preview-speed-overlay-retry" data-testid="preview-speed-retry" onClick={() => activeSpeedPreview.onRetryTask?.(activeSpeedPreview.overlay!.kind === 'failed' ? activeSpeedPreview.overlay!.taskId : '')}><Icon name="refresh" size={12} />{t('speed.processing.retry')}</Button>}</div>)}</> : rendered && !timeline?.clips?.length ? <div className="preview-empty-frame" style={{aspectRatio: `${timeline?.width || 1080} / ${timeline?.height || 1920}`}}><Film size={20}/><p>{t('edit.empty.preview')}</p></div> : <div className="preview-placeholder"><div className="preview-placeholder-icon"><Film size={20}/></div><h3>{rendered ? inProgress ? t('timeline.preview.preparing') : timeline?.clips?.length ? t('timeline.preview.ready') : t('timeline.preview.first') : t('timeline.preview.empty')}</h3><div>{rendered && timeline?.clips?.length ? <Button variant="ghost" className="button primary" disabled={busy || inProgress} onClick={() => onRender('preview')}><Icon name="play" size={15} />{t('timeline.preview.render')}</Button> : <>{canSeed && onSeed && !timeline?.clips?.length && <Button variant="ghost" className="button primary" data-testid="preview-seed-timeline" disabled={busy || seedBusy} onClick={onSeed}><Icon name="layers" size={15} />{t('timeline.preview.seed')}</Button>}{typeof onImport === 'function' && <Button variant="ghost" className={`button ${canSeed && onSeed && !timeline?.clips?.length ? '' : 'primary'}`} onClick={onImport}>{t('timeline.preview.import')}</Button>}{typeof onCanvas === 'function' && <Button variant="ghost" className="button" onClick={onCanvas}>{t('timeline.preview.canvas')}</Button>}</>}</div></div>}
    </TabsContent>
    {aspectFrame && <AspectFrameSuggestion {...aspectFrame} />}
    {kind === 'source' && !clip && type === 'video' && onCaptureFrame && <SourceFrameCaptureControl captureKey={captureKey} inspect={inspectCapture} subscribe={subscribeCapture} onCaptureFrame={onCaptureFrame} captureBusy={captureBusy || blocked} />}{kind === 'source' && !clip && type === 'video' && onDetectScenes && <div className="source-scene-detect"><Button type="button" variant="outline" size="sm" data-testid="source-detect-scenes" disabled={blocked || Boolean(sceneDetectIssue)} title={sceneDetectIssue ? renderMessage(sceneDetectIssue) : undefined} onClick={() => { if (!blocked) onDetectScenes(); }}><Icon name="scissors" size={13} />{t('scene.menu.detect')}</Button>{sceneDetectIssue && <span className="input-hint">{renderMessage(sceneDetectIssue)}</span>}</div>}{withPlaybackPosition(renderPlaybackControls)}
  </Tabs>;
}
