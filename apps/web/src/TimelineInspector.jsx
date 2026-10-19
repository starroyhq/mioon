import './timeline-inspector-editing.css';
import './timeline-removal.css';
import InspectorGroup,{InspectorGroups} from './InspectorGroup.tsx';
import InspectorDraftDisclosure from './InspectorDraftDisclosure.tsx';
import {ClipActionsMenu, useClipRemoval} from './ClipRemovalControls.tsx';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {displayTimelineFrame} from './timeline-removal.ts';
import './timeline-clip-loudness.css';
import TimelineClipLoudness from './TimelineClipLoudness.tsx';
import { useTimelineClipLoudness } from './use-timeline-clip-loudness.ts';
import { clipLoudnessDraftContext } from './timeline-clip-loudness-context.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { Separator } from '@mioon/ui/components/separator';
import { Badge } from '@mioon/ui/components/badge';
import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { assetKind } from './Timeline.jsx';
import Icon from './icons.jsx';
import { sourceFrameCount, isTimelineRecord } from '@mioon/contracts';
import ClipAudioRoleControls from './ClipAudioRoleControls.tsx';
import { clipAudioRoleChanged } from './clip-audio-role-state.ts';
import ClipVolumeEnvelopeControls from './ClipVolumeEnvelopeControls.tsx';
import ClipOpacityEnvelopeControls from './ClipOpacityEnvelopeControls.tsx';
import { rawOpacityEnvelopeFields, rawOpacityEnvelopeChanged, validateRawOpacityEnvelope } from './clip-opacity-envelope-state.ts';
import { readOpacityCandidateInspectorBinding, opacityCandidateTimelineProjection } from './clip-opacity-candidate-assembly.ts';
import { createOpacityImeSubmitGuard } from './opacity-ime-submit-guard.ts';
import { rawVolumeEnvelopeChanged } from './clip-volume-envelope-state.ts';
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

export default function TimelineInspector({ clip, timeline, asset, onSave, onRemove, onRippleRemove, onDirtyChange, busy, onPreview, onReturnToSource, sourceDescription, replacementContext, staleSource, onReplaceSource, onOpenRequests, draftContext, draftConnected = true, onDraftController, onReviewBlockedChange, onCompositionPendingChange, loudnessContext, loudnessInvocation, onLoudnessUnauthorized, opacityCandidate }) {
  const { t, renderMessage, locale, formatNumber } = useI18n();
  const {preferences} = useUiPreferences();
  const visible = useWorkspaceVisibility();
  const requestedOpacity = readOpacityCandidateInspectorBinding(opacityCandidate);
  const opacityOwner = useRef(requestedOpacity);
  const opacity = opacityOwner.current;
  const draftAvailable = draftConnected && opacity === requestedOpacity;
  const opacityEditable = Boolean(opacity && ['image', 'video'].includes(assetKind(asset)) && timeline.tracks.some(track => track.id === clip.trackId && track.kind === 'video'));
  const savedRaw = () => ({ ...clipDraftRaw(clip), ...(opacity ? rawOpacityEnvelopeFields(clip) : {}) });
  const { state, controller } = useClipDraft({ context: {
    scope: draftContext?.scope || `${timeline.projectId}:${clip.id}`, projectId: draftContext?.projectId || timeline.projectId,
    timelineId: timeline.id, clipId: clip.id, restored: Boolean(draftContext?.restored), workspaceOrigin: draftContext?.workspaceOrigin, connected: draftAvailable, busy: Boolean(busy), visible,
    volumeEnvelopeEditable: draftContext?.volumeEnvelopeEditable === true && asset?.hasAudio === true && ['audio', 'video'].includes(assetKind(asset)),
    audioRoleEditable: draftContext?.audioRoleEditable === true && ['audio', 'video'].includes(assetKind(asset)),
    opacityEnvelopeEditable: opacityEditable,
    timelineRevision: timeline.revision, source: clipDraftSource(clip, asset), saved: savedRaw(),
  }, client: opacity?.client, onDirtyChange, onDraftController, onReviewBlockedChange, onCompositionPendingChange, validateTimeline: (value, projectId) => {
    const projected = opacity ? opacityCandidateTimelineProjection(value, projectId) : value;
    return projected !== null && isTimelineRecord(projected, { projectId });
  } });
  busy = Boolean(busy || controller.isDiscarding());
  const draft = state.raw, dirty = state.dirty, conflict = state.conflict;
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kind = assetKind(asset);
  const audioIssue = clipAudioIssue(draft, asset);
  const rectIssue = kind === 'audio' ? '' : timelineRectIssue(draft.rect, timeline);
  const roleEditable = draftContext?.audioRoleEditable === true && ['audio', 'video'].includes(kind);
  const envelopeEligible = asset?.hasAudio === true && ['audio', 'video'].includes(kind);
  const envelopeEditable = envelopeEligible && draftContext?.volumeEnvelopeEditable === true;
  const envelopeChanged = rawVolumeEnvelopeChanged(draft, clipDraftRaw(clip));
  const envelopeCapture = controller.capture();
  const composition = useRef(new Map());
  const compositionPending = Boolean(state.compositionPending);
  const compositionKind = compositionPending ? controller.getPendingEnvelopeKind?.() ?? 'volume' : null;
  const volumeComposing = compositionKind === 'volume';
  const opacityComposing = compositionKind === 'opacity';
  function envelopeComposition(next) {
    if (next.pending) {
      let token = composition.current.get(next.session);
      if (!token) { token = controller.beginVolumeComposition(envelopeCapture); if (token) composition.current.set(next.session, token); }
      if (token) controller.updateVolumeComposition(token, next);
    } else {
      const token = composition.current.get(next.session);
      if (token) { controller.endVolumeComposition(token); composition.current.delete(next.session); }
    }
  }
  function editEnvelope(value, session) {
    const token = session === undefined ? envelopeCapture : composition.current.get(session);
    if (token && controller.editVolumeEnvelope(value, token)) dirtyRef.current = true;
  }
  const opacityComposition = useRef(new Map());
  const opacityImeSubmit = useRef(null);
  if (opacity && !opacityImeSubmit.current) opacityImeSubmit.current = createOpacityImeSubmitGuard();
  // Reuse the existing Inspector confirmation fence for the auxiliary tool.
  // It blocks implicit Save after compositionend without cancelling native IME.
  const duckingImeSubmit = useRef(null);
  function guardOpacityCompositionKey(event) {
    const native = event.nativeEvent || event;
    if (opacity && opacityImeSubmit.current.keyDown({key: event.key, keyCode: native.keyCode, isComposing: native.isComposing === true || event.isComposing === true,
      repeat: native.repeat === true || event.repeat === true, opacityTarget: Boolean(event.target?.getAttribute?.('data-testid')?.startsWith('opacity-envelope-')),
      pending: controller.getPendingEnvelopeKind() === 'opacity'})) event.stopPropagation();
    const duckingTarget = Boolean(event.target?.getAttribute?.('data-testid')?.startsWith('ducking-'));
    if (duckingTarget && !duckingImeSubmit.current) duckingImeSubmit.current = createOpacityImeSubmitGuard();
    if (duckingImeSubmit.current?.keyDown({key: event.key, keyCode: native.keyCode, isComposing: native.isComposing === true || event.isComposing === true,
      repeat: native.repeat === true || event.repeat === true, opacityTarget: duckingTarget,
      pending: controller.hasPendingComposition()})) event.stopPropagation();
  }
  function releaseOpacityCompositionKey(event) {
    if (opacity) opacityImeSubmit.current.keyUp({key: event.key, keyCode: event.nativeEvent?.keyCode ?? event.keyCode, pending: controller.getPendingEnvelopeKind() === 'opacity'});
    duckingImeSubmit.current?.keyUp({key: event.key, keyCode: event.nativeEvent?.keyCode ?? event.keyCode, pending: controller.hasPendingComposition()});
  }
  function releaseOpacityCompositionClick() {
    if (opacity) opacityImeSubmit.current.pointerDown(controller.hasPendingComposition());
    duckingImeSubmit.current?.pointerDown(controller.hasPendingComposition());
  }
  function opacityCompositionChange(next) {
    if (next.pending) {
      let token = opacityComposition.current.get(next.session);
      if (!token) { token = controller.beginOpacityComposition(envelopeCapture); if (token) opacityComposition.current.set(next.session, token); }
      if (token) controller.updateOpacityComposition(token, next);
    } else {
      const token = opacityComposition.current.get(next.session);
      if (token) { controller.endOpacityComposition(token); opacityComposition.current.delete(next.session); }
    }
  }
  function editOpacity(value, session) {
    const token = session === undefined ? envelopeCapture : opacityComposition.current.get(session);
    if (token && controller.editOpacityEnvelope(value, token)) dirtyRef.current = true;
  }
  const proposedOpacityDuration = Number(draft.durationFrames);
  const opacityDurationValid = Number.isSafeInteger(proposedOpacityDuration) && proposedOpacityDuration >= 1 && proposedOpacityDuration <= 18000;
  const opacityIssue = opacity && (!opacityEditable && rawOpacityEnvelopeChanged(draft, savedRaw()) ? t('opacity.envelope.unsupported') : !validateRawOpacityEnvelope(draft, proposedOpacityDuration).valid ? opacityDurationValid ? t('opacity.envelope.bounds', { duration: proposedOpacityDuration }) : t('opacity.envelope.durationInvalid') : '');
  const draftIssue = opacityIssue || (!envelopeEditable && envelopeChanged ? t('volume.envelope.unsupported') : !roleEditable && clipAudioRoleChanged(draft, clipDraftRaw(clip)) ? t('audio.role.unsupportedChange') : clipDraftPatch(draft) ? '' : t('timeline.inspector.draftInvalid'));
  function edit(key, value) { if (controller.edit(key, value)) dirtyRef.current = true; }
  function reset() { if (!draftAvailable || controller.hasPendingComposition()) return; void controller.discard(controller.capture()); }
  async function save(e) {
    e.preventDefault();
    if (opacity && opacityImeSubmit.current.blocksSubmit() || duckingImeSubmit.current?.blocksSubmit()) return;
    if (controller.hasPendingComposition() || !mounted.current || busy || conflict || audioIssue || rectIssue || draftIssue) return;
    await controller.save(onSave);
  }
  const removalBlocked = Boolean(compositionPending || busy || dirty || state.submitting || state.candidate || !draftAvailable || !visible);
  const removal = useClipRemoval({clip, scope: `${draftContext?.scope || timeline.projectId}:${timeline.id}:${timeline.revision}:${clip.id}`, disabled: removalBlocked,
    canRemove: () => mounted.current && visible && draftAvailable && !busy && !controller.hasPendingComposition() && !controller.hasUnsaved() && !controller.getState().candidate,
    onRemove, onRippleRemove: opacity ? undefined : onRippleRemove});
  return <aside className="inspector clip-inspector edit-clip-inspector" data-testid="clip-inspector"><header className="inspector-heading"><Icon name={kind === 'audio' ? 'music' : 'film'} size={14} /><strong title={asset?.name || clip.name}>{asset?.name || clip.name || t('timeline.inspector.title')}</strong><Badge className="small-badge accent">{t('timeline.inspector.fixedAsset')}</Badge><ClipActionsMenu disabled={removalBlocked} disabledHint={dirty || state.candidate ? t('timeline.inspector.saveBeforeRemove') : undefined} onRemove={onRemove ? () => removal.request('remove') : undefined} onRippleRemove={!opacity && onRippleRemove ? () => removal.request('ripple') : undefined} onPreview={onPreview} onReturnToSource={onReturnToSource} /></header>{removal.dialog}<ScrollArea className="edit-inspector-scroll" style={{flex:1,minHeight:0}}><form id="clip-properties-form" className="inspector-scroll clip-form" style={{overflow:'visible'}} onSubmit={save} onKeyDownCapture={guardOpacityCompositionKey} onKeyUpCapture={releaseOpacityCompositionKey} onPointerDownCapture={releaseOpacityCompositionClick}><InspectorDraftDisclosure state={state}><ClipDraftRecovery state={state} memoryOnly={Boolean(opacity && draftContext?.restored && !controller.supportsRestoredPersistence())} restoredPersistence={Boolean(opacity && controller.supportsRestoredPersistence())} disconnected={!draftAvailable} controller={controller} pending={Boolean(busy || compositionPending)} onOpenRequests={onOpenRequests} /></InspectorDraftDisclosure><InspectorGroups key={clip.id} defaultOpen={kind === 'audio' ? ['audio'] : ['basic','visual']}><InspectorGroup groupKey="basic" title={t('edit.group.basic')} initialOpen className="edit-inspector-basic"><Label className="field-label" htmlFor="clip-name">{t('timeline.inspector.name')}</Label><Input id="clip-name" value={draft.name} maxLength={200} onChange={e => edit('name', e.target.value)} /><Label className="field-label" htmlFor="clip-track">{t('timeline.inspector.track')}</Label><WorkbenchSelect id="clip-track" data-testid="clip-track" value={draft.trackId} onChange={e => edit('trackId', e.target.value)}>{timeline.tracks.filter(t => t.kind === (kind === 'audio' ? 'audio' : 'video')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</WorkbenchSelect><div className="field-row"><div><Label className="field-label" htmlFor="clip-start">{t('timeline.inspector.start')}</Label><Input id="clip-start" data-testid="clip-start" type="number" min="0" max="17999" step="1" required value={draft.startFrame} onChange={e => edit('startFrame', e.target.value)} /></div><div><Label className="field-label" htmlFor="clip-duration">{t('timeline.inspector.duration')}</Label><Input id="clip-duration" data-testid="clip-duration" type="number" min="1" max="18000" step="1" required value={draft.durationFrames} onChange={e => edit('durationFrames', e.target.value)} /></div></div><p className="input-hint">{t('timeline.inspector.timeRange', { start: displayTimelineFrame(Number(draft.startFrame) || 0, timeline.fps, preferences.timecodeFormat), end: displayTimelineFrame((Number(draft.startFrame) || 0) + (Number(draft.durationFrames) || 0), timeline.fps, preferences.timecodeFormat) })}</p><Label className="field-label" htmlFor="clip-source-in">{t('timeline.inspector.sourceIn')}</Label><Input id="clip-source-in" data-testid="clip-source-in" type="number" min="0" max={kind === 'image' ? 0 : sourceFrameCount(asset?.duration) === null ? undefined : Math.max(0, sourceFrameCount(asset.duration) - 1)} step="1" required disabled={kind === 'image'} value={draft.sourceInFrame} onChange={e => edit('sourceInFrame', e.target.value)} /><p className="input-hint">{kind === 'image' ? t('timeline.inspector.imageIn') : asset?.duration ? t('timeline.inspector.sourceDuration', { duration: formatNumber(Number(asset.duration), { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) }) : t('timeline.inspector.sourceDurationUnknown')}</p></InspectorGroup>{(kind !== 'audio' || opacity && Object.hasOwn(draft, 'opacityEnvelope')) && <InspectorGroup groupKey="visual" title={t('edit.group.visual')} initialOpen>{kind !== 'audio' && <><Separator className="section-divider" /><div className="section-heading"><span>{t('timeline.inspector.rect')}</span><span>{timeline.width} × {timeline.height}</span></div><div className="rect-grid">{[['x','X'],['y','Y'],['width',t('timeline.inspector.width')],['height',t('timeline.inspector.height')]].map(([key, label]) => <div key={key}><Label className="field-label" htmlFor={`clip-${key}`}>{label} (px)</Label><Input id={`clip-${key}`} data-testid={`clip-${key}`} type="number" min={['x','y'].includes(key) ? 0 : 2} max={['x','width'].includes(key) ? timeline.width : timeline.height} step="2" required value={draft.rect[key]} onChange={e => edit('rect', { ...draft.rect, [key]: e.target.value })} /></div>)}</div><p className="input-hint">{t('timeline.inspector.rectHint')}</p>{rectIssue && <p className="notice warning" role="alert">{renderMessage(timelineRectMessage(draft.rect, timeline))}</p>}</>}{!opacity && <ClipLutControls key={`${draftContext?.scope || timeline.projectId}:${clip.id}:${clip.assetId}:${asset?.sha256 || ''}`} context={{ scope: draftContext?.scope || timeline.projectId, projectId: timeline.projectId, timelineId: timeline.id, clipId: clip.id, assetId: clip.assetId, assetSha256: asset?.sha256 || '', kind, mimeType: asset?.mimeType, colour: draft.colour, blocked: Boolean(busy || state.submitting || state.candidate || conflict || !draftAvailable || draftContext?.restored || !visible) }} kind={kind} restored={Boolean(draftContext?.restored)} onEdit={edit} rpc={rpc} Select={WorkbenchSelect} />}{opacity && (opacityEditable || Object.hasOwn(draft, 'opacityEnvelope')) && <section data-testid="clip-opacity-envelope"><p role="status">{t('opacity.envelope.renderSaved')}</p><ClipOpacityEnvelopeControls value={draft.opacityEnvelope} proposedDuration={Number(draft.durationFrames)} disabled={!opacityComposing && (!opacityEditable || compositionPending || Boolean(busy || state.submitting || state.businessPending || state.candidate || conflict || !draftAvailable || !visible))} onEdit={editOpacity} onCompositionChange={opacityCompositionChange} />{!opacityEditable && <p role="status">{t('opacity.envelope.unsupported')}</p>}{compositionPending && <p role="status">{t('opacity.envelope.composing')}</p>}</section>}</InspectorGroup>}<InspectorGroup groupKey="audio" title={t('edit.group.audio')} initialOpen={kind === 'audio'} className="edit-inspector-audio"><ClipAudioRoleControls capabilityStatus={draftContext?.audioRoleCapability} Select={WorkbenchSelect} kind={kind} value={draft.audioRole} editable={roleEditable} blocked={Boolean(busy || state.submitting || state.businessPending || state.candidate || conflict || !draftAvailable || !visible)} onEdit={value => edit('audioRole', value)} /><ClipAudioControls asset={asset} kind={kind} draft={draft} onEdit={edit} issue={audioIssue} />{(envelopeEligible || Object.prototype.hasOwnProperty.call(draft, 'volumeEnvelope')) && <section data-testid="clip-volume-envelope"><ClipVolumeEnvelopeControls value={draft.volumeEnvelope} proposedDuration={Number.isFinite(Number(draft.durationFrames)) ? Number(draft.durationFrames) : 0} disabled={!volumeComposing && (!envelopeEditable || compositionPending || Boolean(busy || state.submitting || state.businessPending || state.candidate || conflict || !draftAvailable || !visible))} onEdit={editEnvelope} onCompositionChange={envelopeComposition} />{!envelopeEditable && <p role="status">{t(draftContext?.volumeEnvelopeCapability === 'loading' ? 'volume.envelope.loading' : draftContext?.volumeEnvelopeCapability === 'unavailable' ? 'volume.envelope.unavailable' : 'volume.envelope.unsupported')}</p>}{compositionPending && <p role="status">{t('volume.envelope.composing')}</p>}</section>}{!opacity && loudnessContext && <ClipLoudnessObservation context={loudnessContext} invocation={loudnessInvocation} draftController={controller} draftState={state} visible={visible} onUnauthorized={onLoudnessUnauthorized} />}</InspectorGroup><InspectorGroup groupKey="source" title={t('edit.group.source')}><div className="clip-source"><span>{t('timeline.inspector.frozen')}</span><strong title={asset?.name}>{asset?.name || clip.assetId}</strong><p>{t('timeline.inspector.frozenHint')}</p>{staleSource && <p className="clip-source-stale" data-testid="clip-source-stale-note" role="status">{staleSourceSentence(staleSource, locale)}{t('timeline.inspector.staleHint')}</p>}{sourceDescription && <p className="clip-source-description" data-testid="clip-source-description">{sourceDescription}</p>}{onReturnToSource && <Button variant="outline" size="sm" type="button" className="button small return-to-source" data-testid="return-to-source" disabled={busy} onClick={onReturnToSource}><Icon name="left" size={13} />{t('timeline.inspector.returnSource')}</Button>}<Button variant="ghost" size="sm" type="button" className="text-button" data-testid="preview-clip-source" onClick={onPreview}><Icon name="play" size={13} />{t('timeline.inspector.previewSource')}</Button></div>{onReplaceSource && <ClipSourceReplacement context={{ ...replacementContext, timeline, clipId: clip.id, dirty }} getDirty={() => dirtyRef.current} onReplace={onReplaceSource} onOpenRequests={onOpenRequests} />}</InspectorGroup></InspectorGroups>{conflict && <div className="notice warning" role="alert">{t('timeline.inspector.conflict')}<Button variant="ghost" size="sm" type="button" disabled={compositionPending || busy || state.submitting || !draftAvailable} onClick={reset}>{t('timeline.inspector.reload')}</Button></div>}{dirty && draftIssue && <p className="notice warning" role="alert">{draftIssue}</p>}</form></ScrollArea><footer className="edit-inspector-save" onKeyDownCapture={guardOpacityCompositionKey} onKeyUpCapture={releaseOpacityCompositionKey} onPointerDownCapture={releaseOpacityCompositionClick}><span className={dirty ? 'is-dirty' : 'is-saved'} role="status">{t(dirty ? 'timeline.inspector.unsaved' : 'timeline.inspector.synced')}</span><Button variant="ghost" size="sm" type="button" disabled={!dirty || compositionPending || busy || state.submitting || !draftAvailable} onClick={reset}>{t('timeline.inspector.discard')}</Button><Button size="sm" className="button primary" data-testid="save-clip" disabled={compositionPending || !dirty || busy || state.submitting || Boolean(state.candidate) || !draftAvailable || conflict || Boolean(audioIssue || rectIssue || draftIssue)} type="submit" form="clip-properties-form">{t('timeline.inspector.save')}</Button></footer></aside>;
}

function ClipLoudnessObservation({ context, invocation, draftController, draftState, visible, onUnauthorized }) {
  const scopedContext = () => { const base = context(); return { ...base, executionScope: `${base.executionScope}:${JSON.stringify(draftController.capture())}` }; };
  const getContext = () => clipLoudnessDraftContext(scopedContext(), draftController.getState(), visible);
  const loudness = useTimelineClipLoudness({ context: clipLoudnessDraftContext(scopedContext(), draftState, visible), getContext,
    getInvocation: invocation, read: (input, options) => rpc('timeline.clip.loudness', input, options), onUnauthorized });
  return <TimelineClipLoudness loudness={loudness} />;
}
