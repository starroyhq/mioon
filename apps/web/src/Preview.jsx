import { Tabs, TabsList, TabsTrigger, TabsContent } from '@mioon/ui/components/tabs';
import { Button } from '@mioon/ui/components/button';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import Icon from './icons.jsx';
import { disposeMedia } from './Nodes.jsx';
import { assetUrl, statusText } from './api.js';
import { assetKind, framesLabel } from './Timeline.jsx';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { sourceFrameCount, sourcePositionFrame, sourceSeekMatchesTime, SOURCE_RANGE_FPS } from './source-range-state.js';

export default function Preview({ visible = true, kind, onKind, asset, clip, timeline, job, pendingJob, playhead, onSeek, sourceScope, sourcePosition = 0, sourceSeek, onSourcePosition, onRender, busy, onCanvas, onImport }) {
  const media = useRef(null);
  const ancestorVisible = useWorkspaceVisibility();
  visible = visible && ancestorVisible;
  const visibleRef = useRef(visible);
  const rendered = kind === 'timeline';
  const ready = job && ['succeeded','completed','ready'].includes(job.status) && (job.url || job.assetId);
  const stale = ready && job.timelineRevision !== timeline?.revision;
  const url = rendered ? ready ? (job.url || `/media/${job.assetId}`) : '' : assetUrl(asset);
  const type = rendered ? 'video' : assetKind(asset);
  const mediaKey = `${kind}:${type}:${url}:${rendered ? job?.id || job?.timelineRevision : asset?.id || ''}:${clip?.id || ''}:${!rendered && !clip ? sourceScope || '' : ''}`;
  const activeMedia = useRef(null);
  const appliedSourceSeek = useRef(null);
  const sourceRequest = sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek : null;
  const newSourceRequest = sourceRequest && (appliedSourceSeek.current?.scope !== sourceScope || appliedSourceSeek.current?.id !== sourceRequest.id);
  const sourceSeconds = rendered ? playhead / SOURCE_RANGE_FPS : clip ? ((clip.sourceInFrame || 0) + Math.max(0, Math.min(clip.durationFrames, playhead - clip.startFrame))) / SOURCE_RANGE_FPS : (newSourceRequest ? sourceRequest.frame : sourcePosition) / SOURCE_RANGE_FPS;
  const seekRequest = !rendered && !clip ? `${sourceScope || ''}:${sourceSeek && sourceSeek.scope === sourceScope ? sourceSeek.id : 'initial'}` : sourceSeconds;
  useLayoutEffect(() => {
    const element = media.current;
    if (!element) return;
    const binding = { element, key: mediaKey, url, programmaticSeek: null, sourceSeekIntent: null, lastSeekRequest: null };
    activeMedia.current = binding;
    // Restore src when development Strict Mode replays the cleanup/setup pair.
    if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    return () => {
      if (activeMedia.current === binding) activeMedia.current = null;
      disposeMedia(element);
    };
  }, [mediaKey]);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) media.current?.pause();
  }, [visible, mediaKey]);
  function isCurrentMedia(element) {
    const active = activeMedia.current;
    return Boolean(visibleRef.current && element && element.isConnected && element === media.current && active?.element === element && active.key === mediaKey && active.url === url && element.getAttribute('src') === url);
  }
  function seekMedia(element, loadedMetadata = false) {
    if (!isCurrentMedia(element) || !Number.isFinite(sourceSeconds)) return;
    const binding = activeMedia.current;
    // Reopening alone preserves native playback position. A changed playhead or
    // source while hidden still applies its deferred seek when shown again.
    if (!loadedMetadata && binding.lastSeekRequest === seekRequest) return;
    binding.lastSeekRequest = seekRequest;
    if (!rendered && !clip) {
      binding.sourceSeekIntent = newSourceRequest ? sourceRequest.frame : sourcePosition;
      if (sourceRequest) appliedSourceSeek.current = { scope: sourceScope, id: sourceRequest.id };
    }
    const max = Number.isFinite(element.duration) ? Math.max(0, element.duration - (!rendered && !clip ? 0 : .001)) : sourceSeconds;
    const seconds = Math.max(0, Math.min(sourceSeconds, max));
    if (Math.abs(element.currentTime - seconds) > (!rendered && !clip ? 1e-7 : .02)) {
      activeMedia.current.programmaticSeek = seconds;
      element.currentTime = seconds;
    } else if (!rendered && !clip) publishSourcePosition(element);
  }
  useEffect(() => { seekMedia(media.current); }, [playhead, mediaKey, visible, clip?.sourceInFrame, clip?.startFrame, clip?.durationFrames, seekRequest]);
  function guardPlayback(event) {
    const element = event.currentTarget;
    if (!isCurrentMedia(element)) { element.pause(); return; }
    if (!element.seeking) activeMedia.current.programmaticSeek = null;
  }
  function finishSeek(event) {
    const element = event.currentTarget;
    if (!isCurrentMedia(element) || element.seeking) return;
    const binding = activeMedia.current;
    const programmed = binding.programmaticSeek;
    binding.programmaticSeek = null;
    // Restoring the source's clamped display position must not rewrite the
    // independently saved timeline playhead. Native paused scrubbing still can.
    if (programmed !== null && Math.abs(element.currentTime - programmed) < .05) { if (!rendered && !clip) publishSourcePosition(element); return; }
    updateTime(event, true);
  }
  function publishSourcePosition(element) {
    if (!isCurrentMedia(element) || element.seeking) return;
    const binding = activeMedia.current;
    if (!sourceSeekMatchesTime(element.currentTime, binding.sourceSeekIntent)) binding.sourceSeekIntent = null;
    onSourcePosition?.(sourcePositionFrame(element.currentTime, sourceFrameCount(asset?.duration), binding.sourceSeekIntent), sourceScope);
  }
  function pauseMedia(event) {
    // Native pause may land between periodic timeupdate events. Mark controls
    // must see the paused source position, even when the last tick was older.
    if (!rendered && !clip) publishSourcePosition(event.currentTarget);
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
  const inProgress = pendingJob && ['queued','running','pending','submitting'].includes(pendingJob.status);
  return <Tabs value={kind} onValueChange={onKind} className={`central-preview ${visible ? '' : 'workspace-hidden'}`} aria-label="主工作区预览" data-testid="central-preview"><div className="preview-mode-bar"><TabsList className="segmented" aria-label="预览模式"><TabsTrigger value="source" className={!rendered ? 'active' : ''} data-testid="preview-source-mode">源素材快速查看</TabsTrigger><TabsTrigger value="timeline" className={rendered ? 'active' : ''} data-testid="preview-timeline-mode">时间线合成</TabsTrigger></TabsList><span>{rendered ? 'FFmpeg 合成 · 与导出一致' : '即时查看单个素材'}</span></div>
    {rendered && stale && <div className="preview-notice stale" data-testid="preview-stale"><Icon name="info" size={15} /><span>旧快照 rev {job.timelineRevision} · 当前时间线 rev {timeline?.revision}，请重新渲染。</span><Button variant="ghost" disabled={busy || inProgress} onClick={() => onRender('preview')}>更新预览</Button></div>}
    {rendered && inProgress && <div className="preview-notice" data-testid="timeline-render-progress"><span className="spinner" /><span>正在合成时间线 rev {pendingJob.timelineRevision}，完成后自动显示。{ready ? '下方仍是上次完成的快照。' : ''}</span></div>}
    {rendered && pendingJob?.status === 'failed' && <div className="preview-notice stale" role="alert"><span>合成失败：{typeof pendingJob.error === 'string' ? pendingJob.error : pendingJob.error?.message || '请重试'}</span><Button variant="ghost" disabled={busy} onClick={() => onRender('preview')}>重新渲染</Button></div>}
    <TabsContent value={kind} className={`preview-stage ${type === 'audio' ? 'audio-stage' : ''}`}>
      {url ? <>{type === 'image' ? <img className="preview-image" src={url} alt={asset?.name || '源素材'} /> : type === 'audio' ? <div className="audio-preview-art"><div className="audio-bars" aria-hidden="true">{Array.from({ length: 23 }, (_, i) => <i key={i} style={{ height: 22 + ((i * 17) % 58) }} />)}</div><Icon name="music" size={34} /><strong>{asset?.name}</strong><audio ref={media} key={mediaKey} data-testid="source-preview-audio" src={url} controls preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onTimeUpdate={updateTime} onSeeked={finishSeek} /></div> : <video ref={media} key={mediaKey} data-testid={rendered ? 'timeline-preview-video' : 'source-preview-video'} src={url} controls playsInline preload="metadata" onLoadedMetadata={event => seekMedia(event.currentTarget, true)} onPlay={guardPlayback} onPlaying={guardPlayback} onPause={pauseMedia} onTimeUpdate={updateTime} onSeeked={finishSeek} />}<span className="preview-stage-label">{rendered ? `时间线快照 · rev ${job.timelineRevision}${stale ? ' · 已过期' : ' · 当前'}` : clip ? '片段源素材 · 非合成画面' : '源素材'}</span></> : <div className="preview-placeholder"><div className="preview-placeholder-icon"><Icon name={rendered ? 'layers' : 'play'} size={32} /></div><h3>{rendered ? inProgress ? '正在生成可播放的合成预览' : timeline?.clips?.length ? '准备好预览时间线' : '先编排第一个片段' : '在这里认真看每一个画面'}</h3><p>{rendered ? '多轨叠加、裁剪、空隙和混音均使用与导出相同的本地渲染。' : '点击左侧素材，或选择时间线片段，即可在大画面中查看。'}</p><div>{rendered && timeline?.clips?.length ? <Button variant="ghost" className="button primary" disabled={busy || inProgress} onClick={() => onRender('preview')}><Icon name="play" size={15} />渲染时间线预览</Button> : <><Button variant="ghost" className="button primary" onClick={onImport}>导入素材</Button><Button variant="ghost" className="button" onClick={onCanvas}>返回画板</Button></>}</div></div>}
    </TabsContent><footer className="preview-footer"><div><strong>{rendered ? '多轨合成预览' : asset?.name || '尚未选择素材'}</strong><span>{rendered ? ready ? `${statusText(job.status)} · 720 × 1280 · 30 fps` : '渲染结果会持久保存，后续编辑不会覆盖旧文件' : clip ? `时间线开始 ${clip.startFrame} 帧 · 源入点 ${clip.sourceInFrame} 帧 · 长度 ${clip.durationFrames} 帧` : '源素材播放位置独立于时间线；选中片段后可联动播放头'}</span></div><output data-testid={!rendered && !clip ? 'source-preview-position' : undefined}>{framesLabel(!rendered && !clip ? sourcePosition : playhead)}<small> {!rendered && !clip ? '源素材 / 帧' : '时间线 / 帧'}</small></output></footer>
  </Tabs>;
}
