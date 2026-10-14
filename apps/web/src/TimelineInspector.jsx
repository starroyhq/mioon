import { Separator } from '@mioon/ui/components/separator';
import { Badge } from '@mioon/ui/components/badge';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { assetKind, framesLabel } from './Timeline.jsx';
import Icon from './icons.jsx';
import { sourceFrameCount, isTimelineRecord } from '@mioon/contracts';
import ClipAudioControls from './ClipAudioControls.jsx';
import ClipLutControls from './ClipLutControls.tsx';
import { rpc } from './api.js';
import { clipAudioIssue } from './clip-audio-state.js';
import ClipSourceReplacement from './ClipSourceReplacement.jsx';
import { timelineRectIssue } from './timeline-format-state.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { useClipDraft } from './clip-draft-hook.ts';
import { clipDraftRaw, clipDraftSource, clipDraftPatch } from './clip-draft-state.ts';
import ClipDraftRecovery from './ClipDraftRecovery.tsx';
import { staleSourceSentence } from './timeline-source-freshness.ts';

export default function TimelineInspector({ clip, timeline, asset, onSave, onRemove, onDirtyChange, busy, onPreview, onReturnToSource, sourceDescription, replacementContext, staleSource, onReplaceSource, onOpenRequests, draftContext, draftConnected = true, onDraftController, onReviewBlockedChange }) {
  const confirm = useConfirmation();
  const visible = useWorkspaceVisibility();
  const { state, controller } = useClipDraft({ context: {
    scope: draftContext?.scope || `${timeline.projectId}:${clip.id}`, projectId: draftContext?.projectId || timeline.projectId,
    timelineId: timeline.id, clipId: clip.id, restored: Boolean(draftContext?.restored), connected: draftConnected, busy: Boolean(busy), visible,
    timelineRevision: timeline.revision, source: clipDraftSource(clip, asset), saved: clipDraftRaw(clip),
  }, onDirtyChange, onDraftController, onReviewBlockedChange, validateTimeline: (value, projectId) => isTimelineRecord(value, { projectId }) });
  const draft = state.raw, dirty = state.dirty, conflict = state.conflict;
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kind = assetKind(asset);
  const audioIssue = clipAudioIssue(draft, asset);
  const rectIssue = kind === 'audio' ? '' : timelineRectIssue(draft.rect, timeline);
  const draftIssue = clipDraftPatch(draft) ? '' : '请完整填写名称与有效数值；空白数值不会自动转换为 0。';
  function edit(key, value) { if (controller.edit(key, value)) dirtyRef.current = true; }
  function reset() { void controller.discard(controller.capture()); }
  async function save(e) {
    e.preventDefault();
    if (!mounted.current || busy || conflict || audioIssue || rectIssue || draftIssue) return;
    await controller.save(onSave);
  }
  return <aside className="inspector clip-inspector" data-testid="clip-inspector"><header className="inspector-heading"><Icon name="layers" /><span>时间线片段</span><Badge className="small-badge accent">固定素材</Badge></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><form className="inspector-scroll clip-form" style={{ overflow: 'visible' }} onSubmit={save}><div className="section-eyebrow">{kind === 'audio' ? 'AUDIO' : 'VISUAL'} CLIP <Badge className={`small-badge ${dirty ? 'warn' : 'neutral'}`}>{dirty ? '未保存' : '已同步'}</Badge></div><ClipDraftRecovery state={state} controller={controller} pending={Boolean(busy)} onOpenRequests={onOpenRequests} /><Label className="field-label" htmlFor="clip-name">片段名称</Label><Input id="clip-name" value={draft.name} maxLength={200} onChange={e => edit('name', e.target.value)} /><Label className="field-label" htmlFor="clip-track">所在轨道</Label><WorkbenchSelect id="clip-track" data-testid="clip-track" value={draft.trackId} onChange={e => edit('trackId', e.target.value)}>{timeline.tracks.filter(t => t.kind === (kind === 'audio' ? 'audio' : 'video')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</WorkbenchSelect><div className="field-row"><div><Label className="field-label" htmlFor="clip-start">开始帧</Label><Input id="clip-start" data-testid="clip-start" type="number" min="0" max="17999" step="1" required value={draft.startFrame} onChange={e => edit('startFrame', e.target.value)} /></div><div><Label className="field-label" htmlFor="clip-duration">持续帧数</Label><Input id="clip-duration" data-testid="clip-duration" type="number" min="1" max="18000" step="1" required value={draft.durationFrames} onChange={e => edit('durationFrames', e.target.value)} /></div></div><p className="input-hint">30 帧 = 1 秒 · 时间线 {framesLabel(Number(draft.startFrame) || 0)} → {framesLabel((Number(draft.startFrame) || 0) + (Number(draft.durationFrames) || 0))}</p><Label className="field-label" htmlFor="clip-source-in">素材入点（源素材帧）</Label><Input id="clip-source-in" data-testid="clip-source-in" type="number" min="0" max={kind === 'image' ? 0 : sourceFrameCount(asset?.duration) === null ? undefined : Math.max(0, sourceFrameCount(asset.duration) - 1)} step="1" required disabled={kind === 'image'} value={draft.sourceInFrame} onChange={e => edit('sourceInFrame', e.target.value)} /><p className="input-hint">{kind === 'image' ? '静态图片入点固定为 0。' : `源素材 ${asset?.duration ? Number(asset.duration).toFixed(2) + ' 秒' : ''}；入点与时间线开始帧各自独立。`}</p><div className="clip-source"><span>来源已冻结</span><strong title={asset?.name}>{asset?.name || clip.assetId}</strong><p>后续生成或切换镜头版本，不会替换此片段。</p>{staleSource && <p className="clip-source-stale" data-testid="clip-source-stale-note" role="status">{staleSourceSentence(staleSource)}可在下方“替换片段来源”核对改用。</p>}{sourceDescription && <p className="clip-source-description" data-testid="clip-source-description">{sourceDescription}</p>}{onReturnToSource && <Button variant="outline" size="sm" type="button" className="button small return-to-source" data-testid="return-to-source" disabled={busy} onClick={onReturnToSource}><Icon name="left" size={13} />返回来源</Button>}<Button variant="ghost" size="sm" type="button" className="text-button" data-testid="preview-clip-source" onClick={onPreview}><Icon name="play" size={13} />查看原始源素材（未调色）</Button></div>{kind !== 'audio' && <><Separator className="section-divider" /><div className="section-heading"><span>画面位置与尺寸</span><span>{timeline.width} × {timeline.height}</span></div><div className="rect-grid">{[['x','X'],['y','Y'],['width','宽'],['height','高']].map(([key, label]) => <div key={key}><Label className="field-label" htmlFor={`clip-${key}`}>{label}（px）</Label><Input id={`clip-${key}`} data-testid={`clip-${key}`} type="number" min={['x','y'].includes(key) ? 0 : 2} max={['x','width'].includes(key) ? timeline.width : timeline.height} step="2" required value={draft.rect[key]} onChange={e => edit('rect', { ...draft.rect, [key]: e.target.value })} /></div>)}</div><p className="input-hint">偶数像素，画面完整包含于矩形内。矩形留白透明，会显示下层；无任何画面的时间段为黑色。</p>{rectIssue && <p className="notice warning" role="alert">{rectIssue}</p>}</>}<ClipLutControls key={`${draftContext?.scope || timeline.projectId}:${clip.id}:${clip.assetId}:${asset?.sha256 || ''}`} context={{ scope: draftContext?.scope || timeline.projectId, projectId: timeline.projectId, timelineId: timeline.id, clipId: clip.id, assetId: clip.assetId, assetSha256: asset?.sha256 || '', colour: draft.colour, blocked: Boolean(busy || state.submitting || state.candidate || conflict || !draftConnected || draftContext?.restored || !visible) }} kind={kind} restored={Boolean(draftContext?.restored)} onEdit={edit} rpc={rpc} Select={WorkbenchSelect} /><ClipAudioControls asset={asset} kind={kind} draft={draft} onEdit={edit} issue={audioIssue} />{onReplaceSource && <ClipSourceReplacement context={{ ...replacementContext, timeline, clipId: clip.id, dirty }} getDirty={() => dirtyRef.current} onReplace={onReplaceSource} onOpenRequests={onOpenRequests} />}{conflict && <div className="notice warning" role="alert">草稿的时间线版本或来源已变化。你的输入仍保留，不会自动改用新版本；放弃草稿后可载入最新片段。<Button variant="ghost" size="sm" type="button" onClick={reset}>载入最新片段</Button></div>}{dirty && draftIssue && <p className="notice warning" role="alert">{draftIssue}</p>}<div className="clip-form-actions"><Button size="sm" className="button primary full" data-testid="save-clip" disabled={!dirty || busy || state.submitting || Boolean(state.candidate) || !draftConnected || conflict || Boolean(audioIssue || rectIssue || draftIssue)} type="submit"><Icon name="check" size={15} />保存片段</Button>{dirty && <Button variant="ghost" size="sm" type="button" className="text-button" onClick={reset}>放弃修改</Button>}{(dirty || state.candidate) && <p className="input-hint">先保存或放弃片段草稿，再移除此片段。</p>}<Button variant="ghost" size="sm" type="button" className="text-button danger-text" data-testid="remove-clip" disabled={busy || dirty || state.submitting || Boolean(state.candidate)} onClick={async () => { if (!controller.hasUnsaved() && !controller.getState().candidate && await confirm('从时间线移除此片段？原素材与镜头版本会保留。') && mounted.current && !controller.hasUnsaved() && !controller.getState().candidate) onRemove(clip.id); }}>从时间线移除片段</Button></div></form></ScrollArea></aside>;
}
