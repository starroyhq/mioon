import './preview-editing.css';
import PreviewPlaybackControls from './PreviewPlaybackControls.tsx';
import PreviewRenderProgress from './PreviewRenderProgress.tsx';
import {stepPreviewMedia} from './preview-playback.ts';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {Film, Headphones, ChevronDown} from '@mioon/ui/components/workbench-icons';
import { useI18n } from './i18n/I18nProvider.tsx';
import { statusDescriptor, safeTaskErrorCode } from './creation-i18n.ts';
import TimelineAudioPreview from './TimelineAudioPreview.tsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Button } from '@mioon/ui/components/button';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './icons.tsx';
import { disposeMedia } from './Nodes.tsx';
import { assetUrl } from './api.ts';
import { assetKind } from './Timeline.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { exportHistoryDelivery } from './export-settings-state.ts';
import { sourceFrameCount, sourcePositionFrame, sourceSeekMatchesTime, SOURCE_RANGE_FPS } from './source-range-state.ts';
import { opacityCandidateRenderPresentation } from './opacity-candidate-render-presentation.ts';

// Media readiness belongs to the rendered binding. A retained click handler
// always asks the current player again; its displayed enabled state is advisory.
export function SourceFrameCaptureControl({ captureKey, inspect, subscribe, onCaptureFrame, captureBusy }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(null), [submitting, setSubmitting] = useState(false);
  const live = useRef(null), inFlight = useRef(false);
  useLayoutEffect(() => {
    const token = { captureKey, inspect, onCaptureFrame, captureBusy };
    live.current = token;
    const update = () => {
      if (live.current !== token) return;
      const intent = inspect();
      setReady(previous => previous?.key === captureKey && previous?.intent?.sourceFrame === intent?.sourceFrame && Boolean(previous?.intent) === Boolean(intent) ? previous : { key: captureKey, intent });
    };
    const unsubscribe = subscribe(update); update();
    return () => { if (live.current === token) live.current = null; unsubscribe(); };
  }, [captureKey, inspect, subscribe, onCaptureFrame, captureBusy]);
  async function capture() {
    const token = live.current;
    if (!token || token.captureKey !== captureKey || token.captureBusy || inFlight.current) return;
    const intent = token.inspect();
    if (!intent) return;
    inFlight.current = true; setSubmitting(true);
    try { await token.onCaptureFrame(intent); }
    finally { inFlight.current = false; if (live.current) setSubmitting(false); }
  }
  return <div className="source-frame-capture"><Button type="button" variant="outline" size="sm" data-testid="source-frame-capture" disabled={captureBusy || submitting || ready?.key !== captureKey || !ready?.intent} onClick={capture}>{t('timeline.preview.capture')}</Button><span className="input-hint">{t('timeline.preview.captureHint')}</span></div>;
}

export default function Preview({ onBeforePlay, audioPreview, onRegisterMediaPause, visible = true, kind, onKind, asset, clip, timeline, job, pendingJob, playhead, onSeek, sourceScope, sourcePosition = 0, sourceSeek, onSourcePosition, onRender, busy, onCanvas, onImport, onSeed, canSeed = false, seedBusy = false, onCaptureFrame, captureBusy = false, opacityApplication = null, heldExportIds = [], candidateConnected = false }) {
  const { t, renderMessage } = useI18n();
  const {preferences} = useUiPreferences();
  const media = useRef(null);
  useLayoutEffect(() => onRegisterMediaPause?.(() => media.current?.pause()), [onRegisterMediaPause]);
  const ancestorVisible = useWorkspaceVisibility();
  visible = visible && ancestorVisible;
  const visibleRef = useRef(visible);
  const rendered = kind === 'timeline';
  const candidate = opacityApplication !== null;
  const candidateOutput = candidate && rendered ? opacityCandidateRenderPresentation(opacityApplication, job, {projectId: timeline?.projectId, timelineId: timeline?.id, connected: candidateConnected, heldExportIds}) : null;
  const ready = candidate ? Boolean(candidateOutput?.previewHref) : job && ['succeeded','completed','ready'].includes(job.status) && (job.url || job.assetId);
  const stale = ready && job.timelineRevision !== timeline?.revision;
  const url = rendered ? ready ? candidate ? candidateOutput.previewHref : (job.url || `/media/${job.assetId}`) : '' : assetUrl(asset);
  const type = rendered ? 'video' : assetKind(asset);
  const mediaKey = `${kind}:${type}:${url}:${rendered ? job?.id || job?.timelineRevision : asset?.id || ''}:${clip?.id || ''}:${!rendered && !clip ? sourceScope || '' : ''}:${!rendered ? asset?.sha256 || '' : ''}`;
  const activeMedia = useRef(null);
  const appliedSourceSeek = useRef(null);
  const sourceRequest = sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek : null;
  const currentSource = useRef(null);
  currentSource.current = { scope: sourceScope, position: sourcePosition, request: sourceRequest };
  const captureObserver = useRef(null), captureContext = useRef(null);
  const captureKey = `${mediaKey}:${asset?.sha256 || ''}`;
  captureContext.current = { key: captureKey, visible, busy: captureBusy, scope: sourceScope };
  const sourceSeconds = rendered ? playhead / SOURCE_RANGE_FPS : clip ? ((clip.sourceInFrame || 0) + Math.max(0, Math.min(clip.durationFrames, playhead - clip.startFrame))) / SOURCE_RANGE_FPS : null;
  const seekRequest = !rendered && !clip ? `${sourceScope || ''}:${sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek.id : 'initial'}` : sourceSeconds;
  useLayoutEffect(() => {
    const element = media.current;
    if (!element) return;
    const binding = { element, key: mediaKey, url, programmaticSeek: null, sourceSeekIntent: null, pendingSourceSeek: null, lastSeekRequest: null };
    activeMedia.current = binding;
    // Restore src when development Strict Mode replays the cleanup/setup pair.
    if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    captureObserver.current?.();
    return () => {
      if (activeMedia.current === binding) activeMedia.current = null;
      disposeMedia(element);
    };
  }, [mediaKey]);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) media.current?.pause();
    captureObserver.current?.();
  }, [visible, mediaKey]);
  function isCurrentMedia(element) {
    const active = activeMedia.current;
    return Boolean(visibleRef.current && element && element.isConnected && element === media.current && active?.element === element && active.key === mediaKey && active.url === url && element.getAttribute('src') === url);
  }
  function inspectCapture() {
    const element = media.current, binding = activeMedia.current, current = captureContext.current;
    if (kind !== 'source' || clip || type !== 'video' || !onCaptureFrame || !sourceScope || current?.key !== captureKey || current.scope !== sourceScope || !current.visible || current.busy || !isCurrentMedia(element) || !element.paused || element.seeking || element.readyState < 2 || !Number.isFinite(element.currentTime) || element.currentTime < 0 || binding.pendingSourceSeek || binding.programmaticSeek !== null) return null;
    const request = currentSource.current.request;
    const acknowledged = request && appliedSourceSeek.current?.scope === sourceScope && appliedSourceSeek.current?.id === request.id;
    if (request && !acknowledged) return null;
    const count = sourceFrameCount(asset?.duration);
    if (count === null || !/^[a-f0-9]{64}$/.test(asset?.sha256 || '')) return null;
    const intent = acknowledged && binding.sourceSeekIntent === request.frame && sourceSeekMatchesTime(element.currentTime, request.frame) ? request.frame : null;
    const sourceFrame = sourcePositionFrame(element.currentTime, count, intent);
    if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0 || sourceFrame >= count) return null;
    return Object.freeze({ sourceScope, sourceAssetId: asset.id, sourceHash: asset.sha256, sourceFrame });
  }
  function subscribeCapture(update) {
    captureObserver.current = update;
    return () => { if (captureObserver.current === update) captureObserver.current = null; };
  }
  function updateCapture(event) {
    if (isCurrentMedia(event.currentTarget)) captureObserver.current?.();
  }
  function seekMedia(element, loadedMetadata = false) {
    if (!isCurrentMedia(element)) return;
    const standaloneSource = !rendered && !clip;
    if (standaloneSource && element.readyState < 1) return;
    const source = currentSource.current, request = source.request;
    const newSourceRequest = request && (appliedSourceSeek.current?.scope !== source.scope || appliedSourceSeek.current?.id !== request.id);
    const sourceFrame = newSourceRequest ? request.frame : source.position;
    const targetSeconds = standaloneSource ? sourceFrame / SOURCE_RANGE_FPS : sourceSeconds;
    if (!Number.isFinite(targetSeconds)) return;
    const binding = activeMedia.current;
    const currentSeekRequest = standaloneSource ? `${source.scope || ''}:${request?.id ?? 'initial'}` : seekRequest;
    // Reopening alone preserves native playback position. A changed playhead or
    // source while hidden still applies its deferred seek when shown again.
    if (!loadedMetadata && binding.lastSeekRequest === currentSeekRequest) {
      if (standaloneSource && binding.pendingSourceSeek) publishSourcePosition(element);
      return;
    }
    binding.lastSeekRequest = currentSeekRequest;
    if (standaloneSource) {
      binding.sourceSeekIntent = sourceFrame;
      // A currentTime assignment is not confirmation: metadata or seeked may
      // still be pending across rerenders, tab changes, or a hidden player.
      binding.pendingSourceSeek = newSourceRequest ? { scope: source.scope, id: request.id } : null;
    }
    const max = Number.isFinite(element.duration) ? Math.max(0, element.duration - (!rendered && !clip ? 0 : .001)) : targetSeconds;
    const seconds = Math.max(0, Math.min(targetSeconds, max));
    if (Math.abs(element.currentTime - seconds) > (!rendered && !clip ? 1e-7 : .02)) {
      activeMedia.current.programmaticSeek = seconds;
      element.currentTime = seconds;
    } else if (!rendered && !clip) publishSourcePosition(element);
    captureObserver.current?.();
  }
  useEffect(() => { seekMedia(media.current); }, [playhead, mediaKey, visible, clip?.sourceInFrame, clip?.startFrame, clip?.durationFrames, seekRequest]);
  function guardPlayback(event) {
    const element = event.currentTarget;
    if (!isCurrentMedia(element)) { element.pause(); return; }
    onBeforePlay?.();
    audioPreview?.controller.revoke();
    if (!element.seeking) activeMedia.current.programmaticSeek = null;
    captureObserver.current?.();
  }
  function finishSeek(event) {
    const element = event.currentTarget;
    if (!isCurrentMedia(element) || element.seeking) return;
    const binding = activeMedia.current;
    const programmed = binding.programmaticSeek;
    binding.programmaticSeek = null;
    // Restoring the source's clamped display position must not rewrite the
    // independently saved timeline playhead. Native paused scrubbing still can.
    if (programmed !== null && Math.abs(element.currentTime - programmed) < .05) { if (!rendered && !clip) publishSourcePosition(element); captureObserver.current?.(); return; }
    updateTime(event, true);
    captureObserver.current?.();
  }
  function publishSourcePosition(element) {
    if (!isCurrentMedia(element) || element.seeking || element.readyState < 1) return;
    const binding = activeMedia.current;
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
  function pauseMedia(event) {
    // Native pause may land between periodic timeupdate events. Mark controls
    // must see the paused source position, even when the last tick was older.
    if (!rendered && !clip) publishSourcePosition(event.currentTarget);
    updateCapture(event);
  }
  function updateTime(event, nativeSeek = false) {
    const element = event.currentTarget;
    if (!isCurrentMedia(element)) { if (!visibleRef.current) element.pause(); return; }
    if (!nativeSeek && (element.paused || element.seeking || activeMedia.current.programmaticSeek !== null)) return;
    if (rendered) onSeek(Math.round(element.currentTime * 30));
    else if (clip) {
      const frame = Math.round(element.currentTime * 30);
      const sourceIn = clip.sourceInFrame || 0;
      const local = Math.max(0, Math.min(clip.durationFrames, frame - sourceIn));
      onSeek(clip.startFrame + local);
      if (frame >= sourceIn + clip.durationFrames) element.pause();
    } else publishSourcePosition(element);
  }
  const deliveredArtifact = rendered && job?.purpose === 'export';
  const delivery = exportHistoryDelivery(job);
  const inProgress = pendingJob && ['queued','running','pending','submitting'].includes(pendingJob.status);
  const displayFormat = rendered && ready ? job?.snapshot?.timeline : rendered ? timeline : asset;
  const formatLabel = displayFormat?.width && displayFormat?.height ? `${displayFormat.width} × ${displayFormat.height} · ${displayFormat.fps || timeline?.fps || 30} fps` : t('timeline.preview.formatUnavailable');
  const previewMetadata = rendered ? ready ? `${renderMessage(statusDescriptor(job.status))} · ${delivery ? `${delivery.dimensions} · ${delivery.fps} fps · ${renderMessage(delivery.rateMessage || delivery.rate)}` : formatLabel}` : t('timeline.preview.persistent') : clip ? t('timeline.preview.clipPosition',{start:clip.startFrame,source:clip.sourceInFrame??0,duration:clip.durationFrames}) : t('timeline.preview.independent');
  function stepPreview(delta) {stepPreviewMedia({delta,media:media.current,current:isCurrentMedia(media.current),timelineMode:rendered || Boolean(clip),timelineDuration:timeline?.durationFrames || 0,playhead,sourcePosition,sourceCount:sourceFrameCount(asset?.duration),sourceFps:SOURCE_RANGE_FPS,binding:activeMedia.current,onSeek,notify:()=>captureObserver.current?.()});}

  return <Tabs value={kind} onValueChange={onKind} className={`central-preview edit-preview ${visible ? '' : 'workspace-hidden'}`} aria-label={t('timeline.preview.main')} data-testid="central-preview"><div className="preview-mode-bar"><h2 className="sr-only">{t('timeline.preview.title')}</h2><TabsList className="segmented" aria-label={t('timeline.preview.mode')}><TabsTrigger value="source" className={!rendered ? 'active' : ''} data-testid="preview-source-mode">{t('edit.preview.sourceTab')}</TabsTrigger><TabsTrigger value="timeline" className={rendered ? 'active' : ''} data-testid="preview-timeline-mode">{t('edit.preview.timelineTab')}</TabsTrigger></TabsList><span className="edit-preview-format" title={previewMetadata}>{formatLabel}</span></div>
    {rendered && stale && <div className="preview-notice stale" data-testid="preview-stale"><Icon name="info" size={15} /><span>{t('timeline.preview.stale', { rendered: job.timelineRevision, current: timeline?.revision ?? '—' })}</span><Button variant="ghost" disabled={busy || inProgress} onClick={() => onRender('preview')}>{t('timeline.preview.update')}</Button></div>}
    {rendered && inProgress && <PreviewRenderProgress revision={pendingJob.timelineRevision} previous={Boolean(ready)} progress={pendingJob.progress} />}
    {rendered && pendingJob?.status === 'failed' && <div className="preview-notice stale" role="alert"><span>{t('timeline.preview.failed')}{safeTaskErrorCode(pendingJob.error) && <small>{t('timeline.frame.errorCode', { code: safeTaskErrorCode(pendingJob.error) })}</small>}</span><Button variant="ghost" disabled={busy} onClick={() => onRender('preview')}>{t('timeline.preview.rerender')}</Button></div>}
    {rendered && audioPreview && <details className="edit-preview-audio"><summary><Headphones size={14}/><span>{t('audio.preview.title')}</span><ChevronDown size={12}/></summary><TimelineAudioPreview audioPreview={audioPreview} startFrame={playhead} /></details>}
    <TabsContent value={kind} className={`preview-stage ${type === 'audio' ? 'audio-stage' : ''}`}>
      {url ? <>{type === 'image' ? <img className="preview-image" src={url} alt={asset?.name || t('timeline.preview.source')} /> : type === 'audio' ? <div className="audio-preview-art"><Icon name="music" size={34} /><strong>{asset?.name}</strong><audio ref={media} key={mediaKey} data-testid="source-preview-audio" src={url} preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onTimeUpdate={updateTime} onSeeked={finishSeek} /></div> : <video ref={media} key={mediaKey} data-testid={rendered ? 'timeline-preview-video' : 'source-preview-video'} src={url} playsInline preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onTimeUpdate={updateTime} onSeeked={finishSeek} onLoadedData={updateCapture} onCanPlay={updateCapture} onSeeking={updateCapture} onEmptied={updateCapture} />}<span className="preview-stage-label" style={!rendered ? {whiteSpace: 'normal', textAlign: 'center'} : undefined}>{rendered ? t('timeline.preview.stage', { kind: t(deliveredArtifact ? 'timeline.preview.final' : 'timeline.preview.editing'), revision: job.timelineRevision, status: t(stale ? 'timeline.preview.expired' : 'timeline.preview.current') }) : clip ? t('timeline.preview.clipOriginal') : t('timeline.preview.original')}{!rendered && <><br/><span data-testid="preview-source-unprocessed">{t('timeline.preview.sourceUnprocessed')}</span></>}</span></> : rendered && !timeline?.clips?.length ? <div className="preview-empty-frame" style={{aspectRatio: `${timeline?.width || 1080} / ${timeline?.height || 1920}`}}><Film size={20}/><p>{t('edit.empty.preview')}</p></div> : <div className="preview-placeholder"><div className="preview-placeholder-icon"><Film size={20}/></div><h3>{rendered ? inProgress ? t('timeline.preview.preparing') : timeline?.clips?.length ? t('timeline.preview.ready') : t('timeline.preview.first') : t('timeline.preview.empty')}</h3><p>{rendered ? t('timeline.preview.renderDetail') : t('timeline.preview.sourceDetail')}</p><div>{rendered && timeline?.clips?.length ? <Button variant="ghost" className="button primary" disabled={busy || inProgress} onClick={() => onRender('preview')}><Icon name="play" size={15} />{t('timeline.preview.render')}</Button> : <>{canSeed && onSeed && !timeline?.clips?.length && <Button variant="ghost" className="button primary" data-testid="preview-seed-timeline" disabled={busy || seedBusy} onClick={onSeed}><Icon name="layers" size={15} />{t('timeline.preview.seed')}</Button>}{typeof onImport === 'function' && <Button variant="ghost" className={`button ${canSeed && onSeed && !timeline?.clips?.length ? '' : 'primary'}`} onClick={onImport}>{t('timeline.preview.import')}</Button>}{typeof onCanvas === 'function' && <Button variant="ghost" className="button" onClick={onCanvas}>{t('timeline.preview.canvas')}</Button>}</>}</div></div>}
    </TabsContent>{kind === 'source' && !clip && type === 'video' && onCaptureFrame && <SourceFrameCaptureControl captureKey={captureKey} inspect={inspectCapture} subscribe={subscribeCapture} onCaptureFrame={onCaptureFrame} captureBusy={captureBusy} />}<PreviewPlaybackControls bindingKey={`${mediaKey}:${visible}`} getMedia={() => media.current} isCurrent={isCurrentMedia} position={!rendered && !clip ? sourcePosition : playhead} duration={!rendered && !clip ? sourceFrameCount(asset?.duration) || 0 : rendered && ready ? job.snapshot?.timeline?.durationFrames || timeline?.durationFrames || 0 : timeline?.durationFrames || 0} fps={timeline?.fps || 30} format={preferences.timecodeFormat} standaloneSource={!rendered && !clip} onStep={stepPreview} metadata={previewMetadata} />
  </Tabs>;
}
