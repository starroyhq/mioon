import './timeline-clip-loudness.css';
import TimelineClipLoudness from './TimelineClipLoudness.tsx';
import { useTimelineClipLoudness } from './use-timeline-clip-loudness.ts';
import { clipLoudnessDraftContext } from './timeline-clip-loudness-context.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
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
import ClipAudioRoleControls from './ClipAudioRoleControls.tsx';
import { clipAudioRoleChanged } from './clip-audio-role-state.ts';
import ClipAudioControls from './ClipAudioControls.jsx';
import ClipLutControls from './ClipLutControls.tsx';
import { rpc } from './api.js';
import { clipAudioIssue } from './clip-audio-state.js';
import ClipSourceReplacement from './ClipSourceReplacement.jsx';
import { timelineRectIssue, timelineRectMessage } from './timeline-format-state.js';
import { useWorkspaceVisibility } from './workspace-visibility.jsx';
import { useClipDraft } from './clip-draft-hook.ts';
import { clipDraftRaw, clipDraftSource, clipDraftPatch } from './clip-draft-state.ts';
import ClipDraftRecovery from './ClipDraftRecovery.tsx';
import { staleSourceSentence } from './timeline-source-freshness.ts';

export default function TimelineInspector({ clip, timeline, asset, onSave, onRemove, onDirtyChange, busy, onPreview, onReturnToSource, sourceDescription, replacementContext, staleSource, onReplaceSource, onOpenRequests, draftContext, draftConnected = true, onDraftController, onReviewBlockedChange, loudnessContext, loudnessInvocation, onLoudnessUnauthorized }) {
  const { t, renderMessage, locale, formatNumber } = useI18n();
  const confirm = useConfirmation();
  const visible = useWorkspaceVisibility();
  const { state, controller } = useClipDraft({ context: {
    scope: draftContext?.scope || `${timeline.projectId}:${clip.id}`, projectId: draftContext?.projectId || timeline.projectId,
    timelineId: timeline.id, clipId: clip.id, restored: Boolean(draftContext?.restored), connected: draftConnected, busy: Boolean(busy), visible,
    audioRoleEditable: draftContext?.audioRoleEditable === true && ['audio', 'video'].includes(assetKind(asset)),
    timelineRevision: timeline.revision, source: clipDraftSource(clip, asset), saved: clipDraftRaw(clip),
  }, onDirtyChange, onDraftController, onReviewBlockedChange, validateTimeline: (value, projectId) => isTimelineRecord(value, { projectId }) });
  const draft = state.raw, dirty = state.dirty, conflict = state.conflict;
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kind = assetKind(asset);
  const audioIssue = clipAudioIssue(draft, asset);
  const rectIssue = kind === 'audio' ? '' : timelineRectIssue(draft.rect, timeline);
  const roleEditable = draftContext?.audioRoleEditable === true && ['audio', 'video'].includes(kind);
  const draftIssue = !roleEditable && clipAudioRoleChanged(draft, clipDraftRaw(clip)) ? t('audio.role.unsupportedChange') : clipDraftPatch(draft) ? '' : t('timeline.inspector.draftInvalid');
  function edit(key, value) { if (controller.edit(key, value)) dirtyRef.current = true; }
  function reset() { void controller.discard(controller.capture()); }
  async function save(e) {
    e.preventDefault();
    if (!mounted.current || busy || conflict || audioIssue || rectIssue || draftIssue) return;
    await controller.save(onSave);
  }
  return <aside className="inspector clip-inspector" data-testid="clip-inspector"><header className="inspector-heading"><Icon name="layers" /><span>{t('timeline.inspector.title')}</span><Badge className="small-badge accent">{t('timeline.inspector.fixedAsset')}</Badge></header><ScrollArea style={{ flex: 1, minHeight: 0 }}><form className="inspector-scroll clip-form" style={{ overflow: 'visible' }} onSubmit={save}><div className="section-eyebrow">{t(kind === 'audio' ? 'timeline.inspector.audioClip' : 'timeline.inspector.visualClip')} <Badge className={`small-badge ${dirty ? 'warn' : 'neutral'}`}>{dirty ? t('timeline.inspector.unsaved') : t('timeline.inspector.synced')}</Badge></div><ClipDraftRecovery state={state} controller={controller} pending={Boolean(busy)} onOpenRequests={onOpenRequests} /><Label className="field-label" htmlFor="clip-name">{t('timeline.inspector.name')}</Label><Input id="clip-name" value={draft.name} maxLength={200} onChange={e => edit('name', e.target.value)} /><Label className="field-label" htmlFor="clip-track">{t('timeline.inspector.track')}</Label><WorkbenchSelect id="clip-track" data-testid="clip-track" value={draft.trackId} onChange={e => edit('trackId', e.target.value)}>{timeline.tracks.filter(t => t.kind === (kind === 'audio' ? 'audio' : 'video')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</WorkbenchSelect><div className="field-row"><div><Label className="field-label" htmlFor="clip-start">{t('timeline.inspector.start')}</Label><Input id="clip-start" data-testid="clip-start" type="number" min="0" max="17999" step="1" required value={draft.startFrame} onChange={e => edit('startFrame', e.target.value)} /></div><div><Label className="field-label" htmlFor="clip-duration">{t('timeline.inspector.duration')}</Label><Input id="clip-duration" data-testid="clip-duration" type="number" min="1" max="18000" step="1" required value={draft.durationFrames} onChange={e => edit('durationFrames', e.target.value)} /></div></div><p className="input-hint">{t('timeline.inspector.timeRange', { start: framesLabel(Number(draft.startFrame) || 0), end: framesLabel((Number(draft.startFrame) || 0) + (Number(draft.durationFrames) || 0)) })}</p><Label className="field-label" htmlFor="clip-source-in">{t('timeline.inspector.sourceIn')}</Label><Input id="clip-source-in" data-testid="clip-source-in" type="number" min="0" max={kind === 'image' ? 0 : sourceFrameCount(asset?.duration) === null ? undefined : Math.max(0, sourceFrameCount(asset.duration) - 1)} step="1" required disabled={kind === 'image'} value={draft.sourceInFrame} onChange={e => edit('sourceInFrame', e.target.value)} /><p className="input-hint">{kind === 'image' ? t('timeline.inspector.imageIn') : asset?.duration ? t('timeline.inspector.sourceDuration', { duration: formatNumber(Number(asset.duration), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) }) : t('timeline.inspector.sourceDurationUnknown')}</p><div className="clip-source"><span>{t('timeline.inspector.frozen')}</span><strong title={asset?.name}>{asset?.name || clip.assetId}</strong><p>{t('timeline.inspector.frozenHint')}</p>{staleSource && <p className="clip-source-stale" data-testid="clip-source-stale-note" role="status">{staleSourceSentence(staleSource, locale)}{t('timeline.inspector.staleHint')}</p>}{sourceDescription && <p className="clip-source-description" data-testid="clip-source-description">{sourceDescription}</p>}{onReturnToSource && <Button variant="outline" size="sm" type="button" className="button small return-to-source" data-testid="return-to-source" disabled={busy} onClick={onReturnToSource}><Icon name="left" size={13} />{t('timeline.inspector.returnSource')}</Button>}<Button variant="ghost" size="sm" type="button" className="text-button" data-testid="preview-clip-source" onClick={onPreview}><Icon name="play" size={13} />{t('timeline.inspector.previewSource')}</Button></div>{kind !== 'audio' && <><Separator className="section-divider" /><div className="section-heading"><span>{t('timeline.inspector.rect')}</span><span>{timeline.width} × {timeline.height}</span></div><div className="rect-grid">{[['x','X'],['y','Y'],['width',t('timeline.inspector.width')],['height',t('timeline.inspector.height')]].map(([key, label]) => <div key={key}><Label className="field-label" htmlFor={`clip-${key}`}>{label} (px)</Label><Input id={`clip-${key}`} data-testid={`clip-${key}`} type="number" min={['x','y'].includes(key) ? 0 : 2} max={['x','width'].includes(key) ? timeline.width : timeline.height} step="2" required value={draft.rect[key]} onChange={e => edit('rect', { ...draft.rect, [key]: e.target.value })} /></div>)}</div><p className="input-hint">{t('timeline.inspector.rectHint')}</p>{rectIssue && <p className="notice warning" role="alert">{renderMessage(timelineRectMessage(draft.rect, timeline))}</p>}</>}<ClipLutControls key={`${draftContext?.scope || timeline.projectId}:${clip.id}:${clip.assetId}:${asset?.sha256 || ''}`} context={{ scope: draftContext?.scope || timeline.projectId, projectId: timeline.projectId, timelineId: timeline.id, clipId: clip.id, assetId: clip.assetId, assetSha256: asset?.sha256 || '', kind, mimeType: asset?.mimeType, colour: draft.colour, blocked: Boolean(busy || state.submitting || state.candidate || conflict || !draftConnected || draftContext?.restored || !visible) }} kind={kind} restored={Boolean(draftContext?.restored)} onEdit={edit} rpc={rpc} Select={WorkbenchSelect} /><ClipAudioRoleControls capabilityStatus={draftContext?.audioRoleCapability} Select={WorkbenchSelect} kind={kind} value={draft.audioRole} editable={roleEditable} blocked={Boolean(busy || state.submitting || state.businessPending || state.candidate || conflict || !draftConnected || !visible)} onEdit={value => edit('audioRole', value)} /><ClipAudioControls asset={asset} kind={kind} draft={draft} onEdit={edit} issue={audioIssue} />{loudnessContext && <ClipLoudnessObservation context={loudnessContext} invocation={loudnessInvocation} draftController={controller} draftState={state} visible={visible} onUnauthorized={onLoudnessUnauthorized} />}{onReplaceSource && <ClipSourceReplacement context={{ ...replacementContext, timeline, clipId: clip.id, dirty }} getDirty={() => dirtyRef.current} onReplace={onReplaceSource} onOpenRequests={onOpenRequests} />}{conflict && <div className="notice warning" role="alert">{t('timeline.inspector.conflict')}<Button variant="ghost" size="sm" type="button" onClick={reset}>{t('timeline.inspector.reload')}</Button></div>}{dirty && draftIssue && <p className="notice warning" role="alert">{draftIssue}</p>}<div className="clip-form-actions"><Button size="sm" className="button primary full" data-testid="save-clip" disabled={!dirty || busy || state.submitting || Boolean(state.candidate) || !draftConnected || conflict || Boolean(audioIssue || rectIssue || draftIssue)} type="submit"><Icon name="check" size={15} />{t('timeline.inspector.save')}</Button>{dirty && <Button variant="ghost" size="sm" type="button" className="text-button" onClick={reset}>{t('timeline.inspector.discard')}</Button>}{(dirty || state.candidate) && <p className="input-hint">{t('timeline.inspector.saveBeforeRemove')}</p>}<Button variant="ghost" size="sm" type="button" className="text-button danger-text" data-testid="remove-clip" disabled={busy || dirty || state.submitting || Boolean(state.candidate)} onClick={async () => { if (!controller.hasUnsaved() && !controller.getState().candidate && await confirm(message('timeline.inspector.removeConfirm')) && mounted.current && !controller.hasUnsaved() && !controller.getState().candidate) onRemove(clip.id); }}>{t('timeline.inspector.remove')}</Button></div></form></ScrollArea></aside>;
}

function ClipLoudnessObservation({ context, invocation, draftController, draftState, visible, onUnauthorized }) {
  const scopedContext = () => { const base = context(); return { ...base, executionScope: `${base.executionScope}:${JSON.stringify(draftController.capture())}` }; };
  const getContext = () => clipLoudnessDraftContext(scopedContext(), draftController.getState(), visible);
  const loudness = useTimelineClipLoudness({ context: clipLoudnessDraftContext(scopedContext(), draftState, visible), getContext,
    getInvocation: invocation, read: (input, options) => rpc('timeline.clip.loudness', input, options), onUnauthorized });
  return <TimelineClipLoudness loudness={loudness} />;
}
