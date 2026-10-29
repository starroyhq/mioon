import {Eye, EyeOff, Volume2, VolumeX} from '@mioon/ui/components/workbench-icons';
import './timeline-editing.css';
import './timeline-removal.css';
import './timeline-source-banner.css';
import type {DragEvent, KeyboardEvent, MouseEvent, SyntheticEvent, UIEvent} from 'react';
import TimelineToolbar from './TimelineToolbar.tsx';
import {ClipActionsMenu, TimelineRemovalShortcuts, useClipRemoval} from './ClipRemovalControls.tsx';
import {useUiPreferences} from './UiPreferencesProvider.tsx';
import {displayTimelineFrame} from './timeline-removal.ts';
import {TIMELINE_TRACK_HEADER_PX,timelinePointerFrameAtElement,timelineVisibleTracks} from './timeline-view-geometry.ts';
import {compactTimelineScrollTop, compactTimelineViewportHeight} from './timeline-compact-layout.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { rulerFrameForKey } from './timeline-keyboard.ts';
import { staleSourceSentence } from './timeline-source-freshness.ts';
import type { StaleClipSource } from './timeline-source-freshness.ts';
import { Collapsible, CollapsibleContent } from '@mioon/ui/components/collapsible';
import { Button } from '@mioon/ui/components/button';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './icons.tsx';
import { assetUrl } from './api.ts';
import {Media} from './Nodes.tsx';
import TimelineHistoryControls from './TimelineHistoryControls.tsx';
import SubtitleLane from './SubtitleLane.tsx';
import TimelineSplitControls from './TimelineSplitControls.tsx';
import TimelineTransitionMarks from './TimelineTransitionMarks.tsx';
import type { ClipTransition } from '@mioon/contracts';
import { timelineDropPreview } from './timeline-snapping.ts';
import TimelineWaveform, { TimelineWaveformControls } from './TimelineWaveform.tsx';
import { useTimelineWaveforms } from './use-timeline-waveforms.ts';
import { WAVEFORM_LIMITS } from './waveform-state.ts';
import { timelineHistoryState } from './timeline-history.ts';
import { timelineSplitState } from './timeline-split.ts';
import type { AppAsset, AppTimeline, AppTimelineClip, AppTimelineTrack } from './App.tsx';
import type { ComponentProps } from 'react';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import type {MenuRemovalControl} from './desktop-menu-client.ts';

export const ASSET_DRAG = 'application/x-workbench-asset';
export const CLIP_DRAG = 'application/x-workbench-clip';
export const assetKind = (asset: AppAsset | null | undefined): string => asset?.mimeType?.split('/')[0] || 'image';
export const framesLabel = (frame: number, fps = 30): string => `${String(Math.floor(frame / fps / 60)).padStart(2, '0')}:${String(Math.floor(frame / fps) % 60).padStart(2, '0')}:${String(frame % fps).padStart(2, '0')}`;
interface AssetDrag {type: 'asset'; id: string; grabFrame?: number}
interface ClipDrag {type: 'clip'; id: string; grabFrame: number}
type ActiveDrag = AssetDrag | ClipDrag;
interface Gesture {drag: ActiveDrag; projectId: string; revision: number}
interface LastDrag {clientX: number; lane: HTMLElement; track: AppTimelineTrack}
interface Interaction {bodyActive: boolean; presentationVisible: boolean}
interface TimelineViewState {[key: string]: unknown}
interface TimelineLocalViewState {pixelsPerSecond: number; scrollLeft: number; scrollTop: number; snappingEnabled: boolean}
interface RenderJobView {status?: string; [key: string]: unknown}
interface DropSnapshot {projectId: string; expectedRevision: number; durationFrames: number}
interface DragLike {
  clientX: number;
  currentTarget: HTMLElement;
  altKey: boolean;
  preventDefault(): void;
  dataTransfer: {types: readonly string[]; dropEffect: string; getData(format: string): string};
}
type Handler<A extends unknown[]> = (...args: A) => unknown;
type TimelineHistoryState = ReturnType<typeof timelineHistoryState>;
type TimelineSplitState = ReturnType<typeof timelineSplitState>;
type DropPreview = ReturnType<typeof timelineDropPreview>;
type Waveforms = ReturnType<typeof useTimelineWaveforms>;
type TimelineWaveformHookOptions = {
  timeline: AppTimeline | null; assets: AppAsset[]; viewport: unknown; pixelsPerFrame: number; active: boolean;
  readOnly?: boolean | undefined; workspaceOrigin?: string | null | undefined;
};
type TimelineWaveformHookState = ReturnType<typeof useTimelineWaveforms> & {readOnly: boolean; autoLimitReached: boolean};
const useTimelineWaveformsTyped = useTimelineWaveforms as unknown as (options: TimelineWaveformHookOptions) => TimelineWaveformHookState;
export interface TimelineProps {
  onRegisterMenuRemoval?: (control: MenuRemovalControl) => () => void;
  onMenuStateChange?: () => void;
  basicEditingOnly?: boolean;
  lockedTrackIds?:ReadonlySet<string>;
  onToggleTrackLock?:(id:string)=>void;
  structureReadOnly?: boolean;
  sessionViewOnly?: boolean;
  staleClips?: ReadonlyMap<string, StaleClipSource>;
  // Shown at the top of the timeline body, above the tracks (the stale-source banner).
  notice?: React.ReactNode;
  waveformReadOnly?: boolean;
  workspaceOrigin?: string | null;
  timeline: AppTimeline | null;
  historyState: TimelineHistoryState;
  onHistory: (direction: string) => unknown;
  splitState: TimelineSplitState;
  onSplit: () => unknown;
  assets: AppAsset[];
  selectedClipId: string | null;
  selectedCueId: string | null | undefined;
  onSelectSubtitle: (cueId: string) => unknown;
  onAddSubtitle: (frame: number) => unknown;
  subtitleBlocked?: boolean;
  onSelectClip: (clipId: string) => unknown;
  /** Adds a cut's default transition as one saved edit; absent hides the quick-add buttons. */
  onAddTransition?: (clipId: string, transition: ClipTransition) => unknown;
  /** Why the quick-add buttons wait, such as an unsaved clip draft. */
  transitionAddBlocked?: DisplayMessage | null;
  onAddAsset: (assetId: string, trackId: string, startFrame: number, snapshot: DropSnapshot) => unknown;
  onAdmitClipDrag?: (clipId: string) => boolean;
  onMoveClip: (clipId: string, trackId: string, startFrame: number, snapshot: DropSnapshot) => unknown;
  onRemove?: ((clipId: string) => unknown) | undefined;
  onRippleRemove?: ((clipId: string) => unknown) | undefined;
  removalBlocked?: boolean;
  onTrackAdd: (kind: string) => unknown;
  onTrackUpdate: (trackId: string, patch: Record<string, unknown>) => unknown;
  onSeed: () => unknown;
  onRender: (purpose: string) => unknown;
  onSeek: (frame: number) => unknown;
  playhead: number;
  collapsed: boolean;
  visible?: boolean;
  presentationVisible?: boolean;
  onCollapse: () => unknown;
  busy?: boolean;
  canSeed?: boolean;
  renderJob?: RenderJobView | null;
  viewState?: TimelineViewState | null;
  onViewStateChange?: (patch: Record<string, unknown>, options?: unknown) => void;
}
// Native dragover protects getData(). Keep only the current in-document gesture
// in memory so the preview can resolve the same asset/clip before drop.
let activeDrag: ActiveDrag | null = null;
export function dragAsset(event: DragEvent, assetId: string): void {
  activeDrag = { type: 'asset', id: assetId };
  event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(ASSET_DRAG, assetId); event.dataTransfer.setData('text/plain', assetId);
}

export default function Timeline({ onRegisterMenuRemoval, onMenuStateChange, lockedTrackIds=new Set<string>(),onToggleTrackLock,basicEditingOnly = false, structureReadOnly = false, sessionViewOnly = false, staleClips = new Map<string, StaleClipSource>(), notice = null, waveformReadOnly = false, workspaceOrigin = null, timeline, historyState, onHistory, splitState, onSplit, assets, selectedClipId, selectedCueId, onSelectSubtitle, onAddSubtitle, subtitleBlocked = false, onSelectClip, onAddTransition, transitionAddBlocked = null, onAddAsset, onMoveClip, onAdmitClipDrag, onRemove, onRippleRemove, removalBlocked = false, onTrackAdd, onTrackUpdate, onSeed, onRender, onSeek, playhead, collapsed, visible = true, presentationVisible = visible, onCollapse, busy, canSeed, renderJob, viewState, onViewStateChange }: TimelineProps) {
  const { t, renderMessage, locale, formatNumber } = useI18n();
  const {preferences} = useUiPreferences();
  const bodyActive = visible && !collapsed;
  // Retained body/portal callbacks must not cross a layout or project render.
  // The collapsed toolbar remains explicit UI; body work has a separate gate.
  const interaction = useRef<Interaction | null>(null);
  const currentInteraction: Interaction = { bodyActive, presentationVisible };
  interaction.current = currentInteraction;
  useLayoutEffect(() => { interaction.current = currentInteraction; return () => { interaction.current = null; }; });
  const bodyCurrent = () => interaction.current === currentInteraction && bodyActive;
  const toolbarCurrent = () => interaction.current === currentInteraction && presentationVisible;
  const bodyAction = <A extends unknown[]>(callback?: Handler<A>): Handler<A> => (...args) => { if (bodyCurrent()) return callback?.(...args); };
  const toolbarAction = <A extends unknown[]>(callback?: Handler<A>): Handler<A> => (...args) => { if (toolbarCurrent()) return callback?.(...args); };
  const selectedClip = timeline?.clips?.find(clip => clip.id === selectedClipId);
  const removal = useClipRemoval({clip: selectedClip, scope: `${timeline?.projectId}:${timeline?.id}:${timeline?.revision}:${selectedClipId}`, disabled: Boolean(removalBlocked || busy || structureReadOnly || collapsed || !visible || selectedClip && lockedTrackIds.has(selectedClip.trackId)), onRemove, onRippleRemove: basicEditingOnly ? undefined : onRippleRemove});
  const menuRemoval = useRef({removal, current: toolbarCurrent}); menuRemoval.current = {removal, current: toolbarCurrent};
  useLayoutEffect(() => {
    let active = true;
    const control: MenuRemovalControl = {available: mode => active && menuRemoval.current.current() && menuRemoval.current.removal.available(mode),
      request: mode => { if (control.available(mode)) menuRemoval.current.removal.request(mode); }};
    const release = onRegisterMenuRemoval?.(control);
    return () => { active = false; release?.(); };
  }, [onRegisterMenuRemoval]);
  useLayoutEffect(() => { onMenuStateChange?.(); });
  const [localViewState, setLocalViewState] = useState<TimelineLocalViewState>({ pixelsPerSecond: 76, scrollLeft: 0, scrollTop: 0, snappingEnabled: true });
  const currentView = viewState || localViewState;
  const pixelsPerSecond = Math.max(28, Math.min(220, Number(currentView.pixelsPerSecond) || 76));
  function updateViewState(patch: Record<string, unknown>, options?: unknown): void {
    if (!viewState) setLocalViewState(current => ({ ...current, ...(patch as Partial<TimelineLocalViewState>) }));
    onViewStateChange?.(patch, options);
  }
  const snappingEnabled = currentView.snappingEnabled !== false;
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const previewRef = useRef<DropPreview | null>(null), gesture = useRef<Gesture | null>(null), lastDrag = useRef<LastDrag | null>(null);
  function showPreview(value: DropPreview | null): void { previewRef.current = value; setPreview(value); }
  function clearDrag(): void { activeDrag = null; gesture.current = null; lastDrag.current = null; showPreview(null); }
  // Cancel and navigation never submit. This also invalidates a gesture when a
  // different writer refreshes its base revision before the user releases it.
  useEffect(() => {
    const cancel = () => clearDrag();
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('dragend', cancel); window.addEventListener('drop', cancel);
    window.addEventListener('keydown', key); window.addEventListener('pagehide', cancel);
    return () => { activeDrag = null; gesture.current = null; previewRef.current = null; lastDrag.current = null; window.removeEventListener('dragend', cancel); window.removeEventListener('drop', cancel); window.removeEventListener('keydown', key); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (gesture.current && (gesture.current.revision !== timeline?.revision || gesture.current.projectId !== timeline?.projectId)) clearDrag(); }, [timeline?.revision, timeline?.projectId]);
  useEffect(() => { if (busy || collapsed || !visible) clearDrag(); }, [busy, collapsed, visible]);
  const viewport = useRef<HTMLDivElement | null>(null);
  const viewportFrame = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [availableViewportHeight, setAvailableViewportHeight] = useState(0);
  const [horizontalScrollbarHeight, setHorizontalScrollbarHeight] = useState(0);
  const [compactTracks, setCompactTracks] = useState(false);
  useEffect(() => {
    const element = viewport.current, frame = viewportFrame.current;
    if (!element || !frame) return;
    const measure = () => {
      setViewportWidth(element.clientWidth);
      setAvailableViewportHeight(frame.clientHeight);
      setHorizontalScrollbarHeight(Math.max(0, element.offsetHeight - element.clientHeight));
      // The body height is stable when the compact footer changes height.
      const bodyHeight = frame.parentElement?.clientHeight || 0;
      setCompactTracks(bodyHeight > 0 && bodyHeight < 174);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(frame); measure();
    return () => observer.disconnect();
  }, []);
  const fps = timeline?.fps || 30;
  const pxFrame = pixelsPerSecond / fps;
  const waveforms = useTimelineWaveformsTyped({ timeline, assets, viewport, pixelsPerFrame: pxFrame, active: bodyActive, readOnly: waveformReadOnly, workspaceOrigin });
  // The waveform hook state is typed by its own owner; only clip id/window keys are needed here.
  const waveformWindows = new Map<string, import('./waveform-state.ts').WaveformWindow>((waveforms.windows as ReadonlyArray<import('./waveform-state.ts').WaveformWindow>).slice(0, WAVEFORM_LIMITS.entries).map(item => [item.clipId, item]));
  const duration = timeline?.durationFrames || 0;
  const contentFrames = Math.max(360, Math.ceil((duration + 90) / 30) * 30);
  const width = Math.max(780, viewportWidth - TIMELINE_TRACK_HEADER_PX, contentFrames * pxFrame);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || collapsed || !visible) return;
    // Workspace switches remount the timeline; restore only session view state.
    element.scrollLeft = Math.max(0, Number(currentView.scrollLeft) || 0);
    element.scrollTop = Math.max(0, Number(currentView.scrollTop) || 0);
  }, [currentView.scrollLeft, currentView.scrollTop, collapsed, visible, width, compactTracks]);
  useLayoutEffect(()=>{if(compactTracks&&bodyActive&&viewport.current)viewport.current.scrollTop=0;},[compactTracks,timeline?.id,bodyActive]);
  const videoTracks = [...(timeline?.tracks || [])].filter(t => t.kind === 'video').sort((a, b) => b.orderIndex - a.orderIndex);
  const tracks = [...videoTracks, ...(timeline?.tracks || []).filter(t => t.kind === 'audio').sort((a, b) => a.orderIndex - b.orderIndex)];
  const pristineEmpty = !timeline?.clips?.length && historyState?.length === 0;
  const normalTracks = timelineVisibleTracks(tracks,pristineEmpty);
  const primaryVideo = [...videoTracks].reverse()[0], primaryAudio = tracks.find(track => track.kind === 'audio');
  const displayedTracks = compactTracks ? [...normalTracks].sort((a, b) => (a.id === primaryVideo?.id ? -2 : a.id === primaryAudio?.id ? -1 : 0) - (b.id === primaryVideo?.id ? -2 : b.id === primaryAudio?.id ? -1 : 0)) : normalTracks;
  const trackLabel = (track: AppTimelineTrack) => /^(Video|Audio)\s*\d+$/i.test(track.name) ? t(track.kind === 'audio' ? 'edit.track.music' : track.id === primaryVideo?.id ? 'edit.track.picture' : 'edit.track.overlay') : track.name;
  const frameAt = (event: {clientX: number; currentTarget: HTMLElement}, el: HTMLElement = event.currentTarget): number => Math.max(0, Math.min(17999, Math.round(timelinePointerFrameAtElement(event.clientX,el,pxFrame) ?? playhead)));
  function over(event: DragLike, track: AppTimelineTrack): void {
    if (!bodyCurrent()) return;
    if (!event.dataTransfer.types.includes(ASSET_DRAG) && !event.dataTransfer.types.includes(CLIP_DRAG)) return;
    event.preventDefault();
    if (busy || lockedTrackIds.has(track.id) || !activeDrag || structureReadOnly && activeDrag.type === 'asset') { event.dataTransfer.dropEffect = 'none'; showPreview(null); return; }
    const drag = activeDrag;
    if (!gesture.current) gesture.current = { drag, projectId: timeline!.projectId, revision: timeline!.revision };
    if (gesture.current.drag !== drag || gesture.current.revision !== timeline!.revision || gesture.current.projectId !== timeline!.projectId) { clearDrag(); return; }
    const clip = drag.type === 'clip' ? timeline!.clips.find(c => c.id === drag.id) : null;
    const asset = assets.find(a => a.id === (clip?.assetId || (drag.type === 'asset' ? drag.id : null)));
    const pointerFrame=timelinePointerFrameAtElement(event.clientX,event.currentTarget,pxFrame);
    if (pointerFrame===null) {showPreview(null);return;}
    const value = timelineDropPreview({ timeline, track, asset, clip, pointerFrame, grabFrame: drag.grabFrame || 0, pixelsPerFrame: pxFrame, playhead, enabled: snappingEnabled, altKey: event.altKey });
    lastDrag.current = { clientX: event.clientX, lane: event.currentTarget, track };
    showPreview(value);
    event.dataTransfer.dropEffect = value.valid ? (drag.type === 'clip' ? 'move' : 'copy') : 'none';
  }
  // Alt may change with a stationary pointer. Browsers that suppress key events
  // during native dragging still report it on their repeating dragover events.
  useEffect(() => {
    const modifier = (event: globalThis.KeyboardEvent) => {
      const last = lastDrag.current;
      if (!last || !activeDrag || !['Alt', 'AltGraph'].includes(event.key)) return;
      over({ clientX: last.clientX, currentTarget: last.lane, altKey: event.altKey, preventDefault() {}, dataTransfer: { types: [activeDrag.type === 'clip' ? CLIP_DRAG : ASSET_DRAG], dropEffect: '', getData: () => '' } }, last.track);
    };
    window.addEventListener('keydown', modifier); window.addEventListener('keyup', modifier);
    return () => { window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); };
  });
  async function drop(event: DragLike, track: AppTimelineTrack): Promise<void> {
    event.preventDefault();
    if (!bodyCurrent()) return;
    const value = previewRef.current, session = gesture.current, drag = activeDrag;
    const allowed = !busy && !lockedTrackIds.has(track.id) && !(structureReadOnly && drag?.type === 'asset') && value?.valid && value.trackId === track.id && session?.drag === drag && session.projectId === timeline!.projectId && session.revision === timeline!.revision;
    let payloadMatches = false;
    try { payloadMatches = drag?.type === 'clip' ? JSON.parse(event.dataTransfer.getData(CLIP_DRAG)).id === drag.id : event.dataTransfer.getData(ASSET_DRAG) === drag?.id; } catch { /* Invalid payload cannot submit. */ }
    clearDrag();
    if (!allowed || !payloadMatches || value!.unchanged) return;
    const snapshot: DropSnapshot = { projectId: session!.projectId, expectedRevision: session!.revision, durationFrames: value!.durationFrames };
    // Commit exactly the displayed frame, not a new position computed on drop.
    if (drag!.type === 'clip') await onMoveClip(drag!.id, track.id, value!.startFrame, snapshot);
    else await onAddAsset(drag!.id, track.id, value!.startFrame, snapshot);
  }
  const stepSeconds = pixelsPerSecond < 45 ? 5 : pixelsPerSecond < 65 ? 2 : 1;
  const ticks = Array.from({ length: Math.ceil(width / (pixelsPerSecond * stepSeconds)) + 1 }, (_, i) => i * stepSeconds);
  return <Collapsible open={!collapsed} onOpenChange={toolbarAction(onCollapse)} render={<section />} className={`timeline-panel edit-timeline ${collapsed ? 'is-collapsed' : ''} ${compactTracks ? 'compact-tracks' : ''}`} aria-label={t('timeline.view.region')} data-testid="timeline-panel">
    <TimelineToolbar playhead={playhead} fps={fps} timecodeFormat={preferences.timecodeFormat} onSeek={toolbarAction(onSeek)} collapsed={collapsed} onCollapse={toolbarAction(onCollapse)} snapping={snappingEnabled} onSnap={toolbarAction(() => updateViewState({snappingEnabled: !snappingEnabled}))} snapHint={t(sessionViewOnly ? 'opacity.restored.snapHint' : 'timeline.view.snapHint')} pixelsPerSecond={pixelsPerSecond} onZoom={toolbarAction((pixelsPerSecond: number) => updateViewState({pixelsPerSecond}))} history={<TimelineHistoryControls state={historyState} onHistory={toolbarAction(onHistory)} busy={busy||lockedTrackIds.size>0} />} split={!basicEditingOnly && <TimelineSplitControls state={splitState} onSplit={toolbarAction(onSplit)} />} waveform={!basicEditingOnly && <TimelineWaveformControls state={{...waveforms,setEnabled: toolbarAction(waveforms.setEnabled),retry: toolbarAction(waveforms.retry)}} disabled={!timeline} />} trackDisabled={Boolean(structureReadOnly || !timeline || busy || tracks.length >= 12)} onTrackAdd={toolbarAction((kind: string) => {if (!structureReadOnly) onTrackAdd(kind);})} seedDisabled={Boolean(!canSeed || duration > 0 || busy)} onSeed={!basicEditingOnly ? toolbarAction(onSeed) : undefined} renderDisabled={!duration || busy || ['queued','running','pending'].includes(renderJob?.status as string)} rendering={['queued','running'].includes(renderJob?.status as string)} onRender={toolbarAction(() => onRender('preview'))} selectionActions={selectedClip && <ClipActionsMenu disabled={Boolean(removalBlocked || busy || structureReadOnly || collapsed || !visible)} onRemove={onRemove ? toolbarAction(() => removal.request('remove')) : undefined} onRippleRemove={!basicEditingOnly && onRippleRemove ? toolbarAction(() => removal.request('ripple')) : undefined} />} />
    <TimelineRemovalShortcuts disabled={Boolean(!selectedClip || removalBlocked || busy || structureReadOnly || collapsed || !visible)} request={bodyAction(removal.request)} />{removal.dialog}
    <CollapsibleContent className="timeline-body" keepMounted hidden={!bodyActive} inert={!bodyActive} aria-hidden={!bodyActive}>
      {notice}<div className="timeline-scroll-frame" ref={viewportFrame}><div className="timeline-scroll" ref={viewport} data-testid="timeline-scroll" style={compactTracks ? {height: compactTimelineViewportHeight(availableViewportHeight, horizontalScrollbarHeight)} : undefined} onScroll={(event: UIEvent<HTMLDivElement>) => { const element = event.currentTarget; if (bodyCurrent()) updateViewState({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop }, workspaceOrigin ? { passive: true } : undefined); }} onScrollEnd={(event: UIEvent<HTMLDivElement>) => { if (bodyCurrent() && compactTracks) event.currentTarget.scrollTop = compactTimelineScrollTop(event.currentTarget.scrollTop); }}><div className="timeline-content" style={{ width: width + TIMELINE_TRACK_HEADER_PX }}><div className="timeline-ruler-row" data-text-selectable={false}><div className="track-label ruler-label">{t('timeline.view.track')}<span>{t('timeline.view.stacking')}</span></div><div className="timeline-ruler" style={{ width }} role="slider" aria-label={t('timeline.view.ruler')} aria-valuemin={0} aria-valuemax={18000} aria-valuenow={playhead} tabIndex={0} onClick={bodyAction((e: MouseEvent<HTMLDivElement>) => onSeek(frameAt(e)))} onKeyDown={bodyAction((e: KeyboardEvent<HTMLDivElement>) => { const frame = rulerFrameForKey(e.key, playhead); if (frame !== null) { e.preventDefault(); onSeek(frame); } })}>{ticks.map(second => <span key={second} className={`ruler-tick ${Math.abs(second * pixelsPerSecond - playhead * pxFrame) < 24 ? 'playhead-overlap' : ''}`}  style={{ left: second * pixelsPerSecond }}>{String(Math.floor(second / 60)).padStart(2, '0')}:{String(second % 60).padStart(2, '0')}</span>)}<div className="ruler-head" style={{ left: playhead * pxFrame }} /></div></div>
        {timeline && !pristineEmpty && !basicEditingOnly && <SubtitleLane timeline={timeline as unknown as ComponentProps<typeof SubtitleLane>['timeline']} pixelsPerFrame={pxFrame} pixelsPerSecond={pixelsPerSecond} width={width} playhead={playhead} selectedCueId={selectedCueId} onSelect={bodyAction(onSelectSubtitle)} onAdd={bodyAction(onAddSubtitle)} onSeek={bodyAction(onSeek)} busy={busy || subtitleBlocked} visible={bodyActive} />}
        {displayedTracks.map((track, index) => <div className={`timeline-track ${track.kind} ${track.hidden ? 'track-hidden' : ''} ${track.muted ? 'track-muted' : ''}`} key={track.id} data-testid={`timeline-track-${track.id}`} data-waveform-track={track.id}><div className="track-label" data-text-selectable={false}><div><span className={`track-kind ${track.kind}`}>{track.kind === 'audio' ? 'A' : 'V'}{track.kind === 'audio' ? tracks.filter(t => t.kind === 'audio').indexOf(track) + 1 : videoTracks.length - videoTracks.indexOf(track)}</span><strong title={trackLabel(track)}>{trackLabel(track)}</strong></div><div className="track-controls">{track.kind === 'video' && <Button variant="ghost" size="icon-sm" aria-label={t('timeline.view.showTrack', {name: trackLabel(track)})} title={t('timeline.view.pictureOnly')} aria-pressed={!track.hidden} disabled={!bodyActive || structureReadOnly || busy} onClick={bodyAction(() => {if (!structureReadOnly && !busy) onTrackUpdate(track.id,{hidden: !track.hidden});})}>{track.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</Button>}<Button variant="ghost" size="icon-sm" aria-label={t('timeline.view.muteTrack',{name: trackLabel(track)})} title={t('timeline.view.allTrackSound')} aria-pressed={track.muted} disabled={!bodyActive || structureReadOnly || busy} onClick={bodyAction(() => {if (!structureReadOnly && !busy) onTrackUpdate(track.id,{muted: !track.muted});})}>{track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</Button>{onToggleTrackLock&&<Button variant="ghost" size="icon-sm" aria-label={t(lockedTrackIds.has(track.id)?'edit.track.unlock':'edit.track.lock',{name:trackLabel(track)})} title={t('edit.track.lockedHint')} aria-pressed={lockedTrackIds.has(track.id)} disabled={!bodyActive||busy} onClick={bodyAction(()=>onToggleTrackLock(track.id))}><Icon name={lockedTrackIds.has(track.id)?'lock':'unlock'} size={14}/></Button>}</div></div><div className={`track-lane ${preview?.trackId === track.id ? (preview.valid ? 'drag-over' : 'drag-invalid') : ''}`} data-text-selectable={false} aria-label={t('timeline.view.dropArea', { name: trackLabel(track) })} data-testid={`track-lane-${track.id}`} style={{ width, backgroundSize: `${pixelsPerSecond}px 100%` }} onClick={bodyAction((e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onSeek(frameAt(e)); })} onDragOver={(e: DragEvent<HTMLDivElement>) => over(e, track)} onDragLeave={bodyAction((e: DragEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { lastDrag.current = null; showPreview(null); } })} onDrop={(e: DragEvent<HTMLDivElement>) => drop(e, track)}>
          {timeline!.clips.filter(clip => clip.trackId === track.id).map(clip => { const asset = assets.find(a => a.id === clip.assetId); const kind = assetKind(asset); const waveform = waveformWindows.get(clip.id); const stale = staleClips.get(clip.id); return <Button variant="ghost" key={clip.id} className={`timeline-clip ${kind} ${selectedClipId === clip.id ? 'selected' : ''} ${waveforms.enabled && waveform ? 'has-waveform' : ''} ${stale ? 'source-stale' : ''}`} style={{ left: clip.startFrame * pxFrame, width: Math.max(8, clip.durationFrames * pxFrame) }} data-testid={`timeline-clip-${clip.id}`} title={t('timeline.view.clipTooltip', { name: clip.name || asset?.name || t('timeline.view.mediaClip'), start: clip.startFrame, end: clip.startFrame + clip.durationFrames, stale: stale ? ` ${staleSourceSentence(stale, locale)}` : '' })} aria-label={t('timeline.view.clipAria', { name: clip.name || asset?.name || t('timeline.view.mediaClip'), stale: stale ? t('timeline.view.newVersion') : '' })} aria-pressed={selectedClipId === clip.id} draggable={bodyActive && !busy && !lockedTrackIds.has(track.id)} onClick={bodyAction((e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onSelectClip(clip.id); })} onDragStart={(e: DragEvent<HTMLButtonElement>) => { if (!bodyCurrent() || busy || lockedTrackIds.has(track.id)) { e.preventDefault(); return; } if (onAdmitClipDrag && !onAdmitClipDrag(clip.id)) { e.preventDefault(); return; } const pointerFrame=timelinePointerFrameAtElement(e.clientX,e.currentTarget,pxFrame); if (pointerFrame===null) {e.preventDefault();return;} const grabFrame = Math.max(0,pointerFrame); activeDrag = { type: 'clip', id: clip.id, grabFrame }; gesture.current = { drag: activeDrag, projectId: timeline!.projectId, revision: timeline!.revision }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(CLIP_DRAG, JSON.stringify({ id: clip.id, grabFrame })); }}>
            {waveforms.enabled && waveform && <TimelineWaveform window={waveform} entry={waveforms.entries.get(waveform.key)} />}{kind === 'image' ? <img src={assetUrl(asset!)} alt="" draggable={false} /> : kind === 'video' ? <><Media asset={asset} className="clip-thumbnail" aria-hidden="true" draggable={false} /><span className="clip-symbol"><Icon name="film" size={12} /></span></> : <span className="clip-symbol"><Icon name={kind === 'audio' ? 'music' : 'film'} size={16} /></span>}<span className="clip-copy"><strong>{clip.name || asset?.name || t('timeline.view.mediaClip')}</strong><small>{t('timeline.view.clipDuration', { frames: clip.durationFrames, seconds: formatNumber(clip.durationFrames / fps, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }) })}</small></span><span className="clip-end-mark" />{selectedClipId === clip.id && <><span className="clip-trim-mark start" aria-hidden="true" /><span className="clip-trim-mark end" aria-hidden="true" /></>}{stale && (clip.durationFrames * pxFrame >= 96 ? <span className="clip-stale-mark is-labelled" aria-hidden="true">{t('timeline.sync.clipBadge')}</span> : <span className="clip-stale-mark" aria-hidden="true" />)}</Button>; })}
          {track.kind === 'video' && <TimelineTransitionMarks clips={timeline!.clips} trackId={track.id} assets={assets} selectedClipId={selectedClipId} pixelsPerFrame={pxFrame} disabled={!bodyActive || Boolean(busy) || lockedTrackIds.has(track.id)} disabledReason={lockedTrackIds.has(track.id) ? t('edit.track.lockedHint') : transitionAddBlocked ? renderMessage(transitionAddBlocked) : null} onSelect={bodyAction(onSelectClip)} onAdd={onAddTransition && !structureReadOnly && !basicEditingOnly ? bodyAction(onAddTransition) : undefined} />}
          {preview?.trackId === track.id && <><div className={`timeline-drop-preview ${preview.valid ? '' : 'invalid'}`} data-testid="timeline-drop-preview" data-start-frame={preview.startFrame} data-duration-frames={preview.durationFrames} data-valid={preview.valid} style={{ left: preview.startFrame * pxFrame, width: Math.max(8, preview.durationFrames * pxFrame) }}><span>{preview.startFrame} → {preview.startFrame + preview.durationFrames}f</span></div>{preview.snap && <div className={`timeline-snap-guide ${preview.valid ? '' : 'invalid'}`} data-testid="timeline-snap-guide" data-snap-frame={preview.snap.frame} style={{ left: preview.snap.frame * pxFrame }}><span>{renderMessage(preview.snap.labelMessage as DisplayMessage)} · {preview.snap.frame}f</span></div>}</>}
          {!timeline!.clips.some(c => c.trackId === track.id) && <span className="track-drop-hint">{t(track.kind === 'audio' ? 'timeline.view.dropAudio' : 'timeline.view.dropVisual')}</span>}<div className="track-playhead" style={{ left: playhead * pxFrame }} /></div></div>)}
        {!timeline?.clips?.length && <div className="timeline-empty edit-timeline-empty"><Icon name="download" size={24} /><div><strong>{t('edit.empty.title')}</strong><p>{t('edit.empty.detail')}</p></div>{canSeed && <Button variant="outline" disabled={busy} onClick={onSeed}>{t('timeline.view.seed')}</Button>}</div>}
      </div></div></div><footer className={`timeline-footnote ${preview && !preview.valid ? 'invalid' : ''}`}><span data-testid="timeline-drop-status" role="status" aria-live="polite">{preview ? t('timeline.view.dropStatus', { action: t(preview.valid ? (preview.unchanged ? 'timeline.view.positionUnchanged' : 'timeline.view.releaseToDrop') : 'timeline.view.cannotDrop'), start: preview.startFrame, end: preview.startFrame + preview.durationFrames, reason: renderMessage(preview.reasonMessage as DisplayMessage) || (preview.altKey ? t('timeline.view.altNoSnap') : preview.snap ? `${renderMessage(preview.snap.labelMessage)} ${preview.snap.frame}f` : snappingEnabled ? t('timeline.view.outsideSnap') : t('timeline.view.snapDisabled')), note: 'noteMessage' in preview && preview.noteMessage && preview.known ? ` · ${renderMessage(preview.noteMessage as DisplayMessage)}` : '' }) : t('timeline.view.dragHint')}</span><span>{t('timeline.view.clipCount', {duration: displayTimelineFrame(duration, fps, preferences.timecodeFormat), count: timeline?.clips?.length || 0})}</span></footer>
    </CollapsibleContent>
  </Collapsible>;
}
