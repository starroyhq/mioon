import type { AgentEditingProof } from './agent-editing-proof.ts';
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
import { clipLoudnessDraftContext, stageClipLoudnessGain } from './timeline-clip-loudness-context.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { Separator } from '@mioon/ui/components/separator';
import { Badge } from '@mioon/ui/components/badge';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { assetKind } from './Timeline.tsx';
import { Volume2, VolumeX } from '@mioon/ui/components/workbench-icons';
import { clipSoundEntriesVisible } from './clip-sound-state.ts';
import './clip-sound.css';
import Icon from './icons.tsx';
import { isTimelineRecord, sourceFrameCount } from '@mioon/contracts';
import { isFormat5Timeline } from '@mioon/contracts/project-format5';
import ClipAudioRoleControls from './ClipAudioRoleControls.tsx';
import { clipAudioRoleChanged } from './clip-audio-role-state.ts';
import ClipVolumeEnvelopeControls from './ClipVolumeEnvelopeControls.tsx';
import ClipDialogueDuckingControls from './ClipDialogueDuckingControls.tsx';
import type { DuckingClip, DuckingTrack } from './dialogue-ducking-state.ts';
import { createOpacityImeSubmitGuard } from './opacity-ime-submit-guard.ts';
import { rawVolumeEnvelopeChanged } from './clip-volume-envelope-state.ts';
import ClipAudioControls from './ClipAudioControls.tsx';
import ClipCrossfadeControls from './ClipCrossfadeControls.tsx';
import './clip-transform.css';
import ClipTransformControls from './ClipTransformControls.tsx';
import ClipTransitionControls from './ClipTransitionControls.tsx';
import type { TransitionContext } from './clip-transition-state.ts';
import type { ClipTransform, ClipTransition } from '@mioon/contracts';
import type { ClipLayout } from '../../../packages/contracts/src/timeline-clip-layout.ts';
import type { CrossfadeCandidate } from './timeline-crossfade-state.ts';
import ClipLutControls from './ClipLutControls.tsx';
import { rpc } from './api.ts';
import { clipAudioIssue } from './clip-audio-state.ts';
import ClipSourceReplacement from './ClipSourceReplacement.tsx';
import { timelineRectIssue, timelineRectMessage } from './timeline-format-state.ts';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { useClipDraft } from './clip-draft-hook.ts';
import { clipDraftRaw, clipDraftSource, clipDraftPatch, sameClipDraftValue } from './clip-draft-state.ts';
import ClipDraftRecovery from './ClipDraftRecovery.tsx';
import { staleSourceSentence } from './timeline-source-freshness.ts';
import type { ClipDraftController, ClipDraftRaw, ClipDraftState } from './clip-draft-state.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import ShotVersionBar from './edit-ui/ShotVersionBar.tsx';
import type { EditUiInspectorSequence } from './edit-ui/status.tsx';
import { editUiTrackPickerLabel } from './edit-ui/status.tsx';
import {
  acquireAgentEditingTargetAtRevision,
  attachAgentEditingParticipant,
  readCachedAgentEditingTargetRevision,
  reconcileAgentEditingTargetClaim,
  releaseAgentEditingTarget,
} from './AgentEditingBoundary.tsx';
import type { AgentEditingClaimResult } from './agent-editing-protection.ts';
import type { AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {
  buildCoEditingComparison,
  clipDraftPatchFromServerValues,
  clipFieldGroup,
  clipFieldTargetKind,
  clipGroupTargetKind,
  findMioWriteForTarget,
  parseCoEditingClaimResult,
  refreshMioActiveWrites,
  useMioActiveWrites,
} from './mio-co-editing.ts';
import type { ClipCoEditingGroup, CoEditingConflict } from './mio-co-editing.ts';
import { MioCoEditingConflictCard } from './MioCoEditingControls.tsx';

const pass = <T,>(value: unknown): T => value as T;
export interface TimelineInspectorClip { id: string; name?: string; trackId: string; startFrame: number; durationFrames: number; assetId: string; rect?: unknown; layout?: ClipLayout; [key: string]: unknown }
export interface TimelineInspectorAsset { id: string; name: string; mimeType: string; sizeBytes: number; hasAudio?: boolean; sha256?: string | null; duration?: unknown; width?: number; height?: number; projectId?: string; provenance?: unknown; [key: string]: unknown }
export interface TimelineInspectorTimeline { id: string; projectId: string; revision: number; fps: number; width: number; height: number; tracks: { id: string; kind?: string; name?: string; [key: string]: unknown }[]; [key: string]: unknown }
export interface TimelineInspectorDraftContext { collaboration?: AgentEditingProof | null; scope?: string; projectId?: string;   volumeEnvelopeEditable?: boolean; audioRoleEditable?: boolean; [key: string]: unknown }
export interface TimelineInspectorStaleSource { code: string; message?: string; [key: string]: unknown }
export interface TimelineInspectorProps {
  clip: TimelineInspectorClip;
  timeline: TimelineInspectorTimeline;
  asset?: TimelineInspectorAsset | null;
  onSave: (clipId: string, patch: Record<string, unknown>, baseRevision: number, options: { canExecute: () => boolean }) => Promise<unknown>;
  onRemove?: (clipId: string) => unknown;
  onRippleRemove?: (clipId: string) => unknown;
  onDirtyChange?: (dirty: boolean) => unknown;
  busy?: boolean;
  onPreview?: () => unknown;
  onSplit?: () => unknown;
  splitDisabled?: boolean;
  onShowAsset?: () => unknown;
  onReturnToSource?: () => unknown;
  sourceDescription?: string;
  replacementContext?: Record<string, unknown>;
  staleSource?: TimelineInspectorStaleSource | null;
  onReplaceSource?: (context: Record<string, unknown>) => unknown;
  onOpenRequests?: () => unknown;
  onRefreshProject?: () => Promise<unknown> | unknown;
  onOpenMioPanel?: () => unknown;
  draftContext?: TimelineInspectorDraftContext | null;
  draftConnected?: boolean;
  onDraftController?: (controller: ClipDraftController) => unknown;
  onReviewBlockedChange?: (blocked: boolean) => unknown;
  onCompositionPendingChange?: (pending: boolean) => unknown;
  loudnessContext?: (() => Record<string, unknown>) | null;
  onLoudnessUnauthorized?: () => unknown;
  /** The selected clip's crossfade pairs; absent hides the section. */
  crossfadeCandidates?: readonly CrossfadeCandidate[];
  onCrossfade?: (outgoingClipId: string, incomingClipId: string) => unknown;
  /** The clip frame under the playhead; transform keyframes are set there. */
  transformFrame?: number;
  /** Saves a clip's transform as one timeline edit; absent hides the section. */
  onSetTransform?: (clipId: string, transform: ClipTransform | null) => unknown;
  /** Whether a cut leads into the clip and how long a transition fits there. */
  transitionContext?: TransitionContext;
  /** Saves the transition at the cut before a clip as one timeline edit; absent hides the section. */
  onSetTransition?: (clipId: string, transition: ClipTransition | null) => unknown;
  /** Format 5 shot/version presentation; absent keeps the pre-UI-E1 panel. */
  sequence?: EditUiInspectorSequence | null;
  /** Format-5 project gate for the clip sound entries. */
  format5?: boolean;
  /** Mute/unmute a clip's own sound as one saved properties action. */
  onToggleClipMute?: (clipId: string, muted: boolean) => unknown;
  /** Separate the clip's sound into an anchored audio clip (one action). */
  onSeparateSound?: (clipId: string) => unknown;
  /** Save the clip's current sound range as a new audio asset (background task). */
  onSaveClipAudio?: (clipId: string) => unknown;
}
type EnvelopeComposition = { pending: boolean; session: string; [key: string]: unknown };
type VolumeToken = NonNullable<ReturnType<ClipDraftController['beginVolumeComposition']>>;
type VolumeEnvelopeValue = Parameters<ClipDraftController['editVolumeEnvelope']>[0];
type EditKey = Parameters<ClipDraftController['edit']>[0];
type ImeGuard = ReturnType<typeof createOpacityImeSubmitGuard>;

interface GroupClaimRecord {
  status: 'claiming' | 'acquired' | 'conflict';
  targetKind: AgentTaskTarget['kind'];
  conflict: CoEditingConflict | null;
  busy: boolean;
}

const TIMING_RAW_KEYS = ['name', 'trackId', 'startFrame', 'durationFrames', 'sourceInFrame'] as const;
const VISUAL_RAW_KEYS = ['rect', 'colour'] as const;
const AUDIO_RAW_KEYS = ['gain', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope'] as const;

function dirtyClipGroups(draft: ClipDraftRaw, saved: ClipDraftRaw): ClipCoEditingGroup[] {
  const groups: ClipCoEditingGroup[] = [];
  if (TIMING_RAW_KEYS.some(key => !sameClipDraftValue(draft[key], saved[key]))) groups.push('timing');
  if (VISUAL_RAW_KEYS.some(key => !sameClipDraftValue(draft[key], saved[key]))) groups.push('visual');
  if (AUDIO_RAW_KEYS.some(key => !sameClipDraftValue(draft[key], saved[key]))) groups.push('audio');
  return groups;
}

export default function TimelineInspector({ crossfadeCandidates, onCrossfade, transformFrame = 0, onSetTransform, transitionContext = { hasCut: false, maxFrames: 0 }, onSetTransition, clip, timeline, asset, onSave, onRemove, onRippleRemove, onDirtyChange, busy, onPreview, onSplit, splitDisabled, onShowAsset, onReturnToSource, sourceDescription, replacementContext, staleSource, onReplaceSource, onOpenRequests, onRefreshProject, onOpenMioPanel, draftContext, draftConnected = true, onDraftController, onReviewBlockedChange, onCompositionPendingChange, loudnessContext, onLoudnessUnauthorized, sequence = null, format5 = false, onToggleClipMute, onSeparateSound, onSaveClipAudio }: TimelineInspectorProps): React.ReactElement {
  const { t, renderMessage, locale, formatNumber } = useI18n();
  const {preferences} = useUiPreferences();
  const [requestedGroup, setRequestedGroup] = useState<{key: string; version: number; clipId: string} | undefined>();
  const visible = useWorkspaceVisibility();
  const draftAvailable = draftConnected;
  const savedRaw = clipDraftRaw(clip);
  const draftResult = useClipDraft(pass({ context: {
    scope: draftContext?.scope || `${timeline.projectId}:${clip.id}`, projectId: draftContext?.projectId || timeline.projectId,
    timelineId: timeline.id, clipId: clip.id,   connected: draftAvailable, busy: Boolean(busy), visible,
    volumeEnvelopeEditable: draftContext?.volumeEnvelopeEditable === true && asset?.hasAudio === true && (['audio', 'video'] as string[]).includes(assetKind(asset) as string),
    audioRoleEditable: draftContext?.audioRoleEditable === true && (['audio', 'video'] as string[]).includes(assetKind(asset) as string),
    collaboration: draftContext?.collaboration, timelineRevision: timeline.revision, source: clipDraftSource(pass(clip), pass(asset)), saved: savedRaw, layout: clip.layout,
  }, onDirtyChange, onDraftController, onReviewBlockedChange, onCompositionPendingChange, validateTimeline: (value: unknown, projectId: string) => value !== null && (format5 ? isFormat5Timeline(value, {projectId}) : isTimelineRecord(value, {projectId})) }));
  const state: ClipDraftState = draftResult.state, controller: ClipDraftController = draftResult.controller;
  busy = Boolean(busy || controller.isDiscarding());
  const draft = state.raw, dirty = state.dirty, conflict = state.conflict;
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Section 25: active Mio writes and independent per-group first-input claims.
  const projectId = draftContext?.projectId || timeline.projectId;
  const mioWrites = useMioActiveWrites(projectId, visible && draftAvailable);
  const timingWrite = findMioWriteForTarget(mioWrites, { kind: 'timeline_clip_timing', id: clip.id });
  const visualWrite = findMioWriteForTarget(mioWrites, { kind: 'timeline_clip_visual', id: clip.id });
  const audioWrite = findMioWriteForTarget(mioWrites, { kind: 'timeline_clip_audio', id: clip.id });

  const [groupClaims, setGroupClaims] = useState<Partial<Record<ClipCoEditingGroup, GroupClaimRecord>>>({});
  const groupClaimsRef = useRef(groupClaims); groupClaimsRef.current = groupClaims;
  const groupPromises = useRef<Partial<Record<ClipCoEditingGroup, Promise<AgentEditingClaimResult>>>>({});
  const groupAttachments = useRef<Map<string, () => void>>(new Map());
  const initialCachedRev = readCachedAgentEditingTargetRevision(projectId, { kind: 'timeline_clip', id: clip.id });
  const baselineRevision = useRef<number>(initialCachedRev ?? 0);
  const baselineRevisionKnown = useRef<boolean>(initialCachedRev !== undefined);
  const baselineScopeKey = useRef<string>(`${projectId}:${clip.id}`);
  const baselineTimelineRev = useRef<number>(timeline.revision);
  const baselineRawRef = useRef<ClipDraftRaw>(savedRaw);
  const [refreshingConflict, setRefreshingConflict] = useState(false);

  const currentScopeKey = `${projectId}:${clip.id}`;
  if (baselineScopeKey.current !== currentScopeKey) {
    baselineScopeKey.current = currentScopeKey;
    baselineTimelineRev.current = timeline.revision;
    const cachedRev = readCachedAgentEditingTargetRevision(projectId, { kind: 'timeline_clip', id: clip.id });
    baselineRevision.current = cachedRev ?? 0;
    baselineRevisionKnown.current = cachedRev !== undefined;
    baselineRawRef.current = savedRaw;
  } else if (!dirty && !Object.keys(groupClaims).length) {
    if (baselineTimelineRev.current !== timeline.revision || !baselineRevisionKnown.current) {
      baselineTimelineRev.current = timeline.revision;
      const cachedRev = readCachedAgentEditingTargetRevision(projectId, { kind: 'timeline_clip', id: clip.id });
      if (cachedRev !== undefined) {
        baselineRevision.current = cachedRev;
        baselineRevisionKnown.current = true;
      }
    }
    baselineRawRef.current = savedRaw;
  }

  function detachGroupClaims(): void {
    for (const detach of groupAttachments.current.values()) detach();
    groupAttachments.current.clear();
  }

  function releaseAllGroupClaims(): Promise<void> {
    const entries = Object.values(groupClaimsRef.current);
    groupPromises.current = {};
    setGroupClaims({});
    detachGroupClaims();
    const releases: Promise<unknown>[] = [];
    for (const entry of entries) {
      if (entry && entry.status === 'acquired') {
        releases.push(releaseAgentEditingTarget(projectId, { kind: entry.targetKind, id: clip.id }));
      }
    }
    return Promise.allSettled(releases).then(() => {
      if (!mounted.current || dirtyRef.current) return;
      const cachedRev = readCachedAgentEditingTargetRevision(projectId, { kind: 'timeline_clip', id: clip.id });
      if (cachedRev !== undefined) {
        baselineRevision.current = cachedRev;
        baselineRevisionKnown.current = true;
      }
    });
  }

  useLayoutEffect(() => () => { detachGroupClaims(); }, [projectId, clip.id]);

  // Auto-release clean group claims after Save or Discard settles the draft.
  const wasDirtyForClaims = useRef(dirty);
  useLayoutEffect(() => {
    if (wasDirtyForClaims.current && !dirty) {
      void releaseAllGroupClaims();
      baselineTimelineRev.current = timeline.revision;
      baselineRawRef.current = savedRaw;
    }
    wasDirtyForClaims.current = dirty;
  }, [dirty, projectId, clip.id]);

  // If a group had a mio_committing rejection and Mio finishes committing,
  // re-probe at the original baseline revision so we seamlessly acquire or show the diff.
  const prevWritesKey = useRef('');
  const writesKey = `${Boolean(timingWrite)}:${Boolean(visualWrite)}:${Boolean(audioWrite)}`;
  useLayoutEffect(() => {
    if (writesKey === prevWritesKey.current) return;
    prevWritesKey.current = writesKey;
    const writeByGroup: Record<ClipCoEditingGroup, unknown> = { timing: timingWrite, visual: visualWrite, audio: audioWrite };
    for (const group of ['timing', 'visual', 'audio'] as const) {
      const record = groupClaimsRef.current[group];
      if (record?.conflict?.kind === 'mio_committing' && !writeByGroup[group]) {
        void claimGroupAtRevision(group, record.targetKind, baselineRevision.current);
      }
    }
  }, [writesKey]);

  function claimGroupAtRevision(
    group: ClipCoEditingGroup,
    targetKind: AgentTaskTarget['kind'],
    revision: number,
  ): Promise<AgentEditingClaimResult> {
    const target: AgentTaskTarget = { kind: targetKind, id: clip.id, revision };
    if (!groupAttachments.current.has(targetKind)) {
      const detach = attachAgentEditingParticipant(projectId, target, {
        visible,
        clean: false,
        canRelease: () => !controller.hasUnsaved() && !controller.hasPendingComposition() && !dirtyRef.current,
        onDiscard: () => controller.discard(controller.capture()),
      });
      groupAttachments.current.set(targetKind, detach);
    }
    setGroupClaims(prev => ({
      ...prev,
      [group]: { status: 'claiming', targetKind, conflict: prev[group]?.conflict ?? null, busy: true },
    }));
    const pending = acquireAgentEditingTargetAtRevision(projectId, target).then(result => {
      if (!mounted.current) return result;
      if (result.status === 'acquired') {
        setGroupClaims(prev => ({
          ...prev,
          [group]: { status: 'acquired', targetKind, conflict: null, busy: false },
        }));
        return result;
      }
      const parsedConflict = parseCoEditingClaimResult(result, target);
      setGroupClaims(prev => ({
        ...prev,
        [group]: { status: 'conflict', targetKind, conflict: parsedConflict, busy: false },
      }));
      if (parsedConflict?.kind === 'mio_committing') {
        void refreshMioActiveWrites(projectId);
      } else if (parsedConflict?.kind === 'revision_changed' && parsedConflict.currentValues === null && onRefreshProject) {
        setRefreshingConflict(true);
        void Promise.resolve(onRefreshProject()).finally(() => {
          if (mounted.current) setRefreshingConflict(false);
        });
      }
      return result;
    });
    groupPromises.current[group] = pending;
    return pending;
  }

  function ensureGroupClaimOnInput(fieldKey: string): void {
    const group = clipFieldGroup(fieldKey);
    const targetKind = clipFieldTargetKind(fieldKey);
    const existing = groupClaimsRef.current[group];
    if (existing && (existing.status === 'acquired' || existing.status === 'claiming' || existing.status === 'conflict')) return;
    void claimGroupAtRevision(group, targetKind, baselineRevision.current);
  }

  async function adoptMioForGroup(group: ClipCoEditingGroup): Promise<void> {
    const record = groupClaimsRef.current[group];
    const groupConflict = record?.conflict;
    if (!record || groupConflict?.kind !== 'revision_changed') return;
    setGroupClaims(prev => ({ ...prev, [group]: { ...record, busy: true } }));
    const serverSource = (groupConflict.currentValues as Record<string, unknown> | null)
      ?? (savedRaw as unknown as Record<string, unknown>);
    const patch = clipDraftPatchFromServerValues(record.targetKind === 'timeline_clip' ? 'whole' : group, serverSource);
    baselineRevision.current = groupConflict.currentRevision;
    baselineRevisionKnown.current = true;
    baselineRawRef.current = { ...baselineRawRef.current, ...patch };
    const stillOtherConflict = (['timing', 'visual', 'audio'] as const).some(
      other => other !== group && groupClaimsRef.current[other]?.status === 'conflict',
    );
    controller.reconcileCoEditing({
      patch,
      clearConflict: !stillOtherConflict,
      adoptNextRevision: !stillOtherConflict,
    });
    const detach = groupAttachments.current.get(record.targetKind);
    if (detach) { detach(); groupAttachments.current.delete(record.targetKind); }
    void releaseAgentEditingTarget(projectId, { kind: record.targetKind, id: clip.id });
    setGroupClaims(prev => {
      const next = { ...prev };
      delete next[group];
      return next;
    });
    delete groupPromises.current[group];
    if (onRefreshProject) void onRefreshProject();
  }

  async function keepMineForGroup(group: ClipCoEditingGroup): Promise<void> {
    const record = groupClaimsRef.current[group];
    const groupConflict = record?.conflict;
    if (!record || groupConflict?.kind !== 'revision_changed') return;
    const result = await claimGroupAtRevision(group, record.targetKind, groupConflict.currentRevision);
    if (!mounted.current || result.status !== 'acquired') return;
    baselineRevision.current = groupConflict.currentRevision;
    baselineRevisionKnown.current = true;
    if (onRefreshProject) await onRefreshProject();
    if (!mounted.current) return;
    const stillOtherConflict = (['timing', 'visual', 'audio'] as const).some(
      other => other !== group && groupClaimsRef.current[other]?.status === 'conflict',
    );
    controller.reconcileCoEditing({
      clearConflict: !stillOtherConflict,
      adoptNextRevision: !stillOtherConflict,
    });
  }

  async function reconcileUnknownForGroup(group: ClipCoEditingGroup): Promise<void> {
    const record = groupClaimsRef.current[group];
    const groupConflict = record?.conflict;
    if (!record || groupConflict?.kind !== 'claim_unknown') return;
    setGroupClaims(prev => ({ ...prev, [group]: { ...record, busy: true } }));
    const target: AgentTaskTarget = { kind: record.targetKind, id: clip.id, revision: groupConflict.revision };
    const result = await reconcileAgentEditingTargetClaim(projectId, target, groupConflict.requestId);
    if (!mounted.current) return;
    if (result.status === 'acquired') {
      setGroupClaims(prev => ({
        ...prev,
        [group]: { status: 'acquired', targetKind: record.targetKind, conflict: null, busy: false },
      }));
      return;
    }
    const nextConflict = parseCoEditingClaimResult(result, target);
    setGroupClaims(prev => ({
      ...prev,
      [group]: { status: 'conflict', targetKind: record.targetKind, conflict: nextConflict, busy: false },
    }));
  }

  const kind = assetKind(asset) as 'audio' | 'video' | 'image' | undefined;
  // The main track keeps its explicit `V1 · 主轨` value in the track picker.
  const trackOptionLabel = (track: TimelineInspectorTimeline['tracks'][number]): string =>
    editUiTrackPickerLabel(t, track, timeline.tracks, sequence?.mainTrackId ?? null);
  const trackNameById = (trackId: string): string | undefined => {
    const track = timeline.tracks.find(item => item.id === trackId);
    return track ? trackOptionLabel(track) : undefined;
  };
  const audioIssue = clipAudioIssue(draft, asset);
  // Clip sound entries: a ready video clip with an actual audio stream on a
  // picture track. The service re-validates every action.
  const soundEntries = clipSoundEntriesVisible({format5, clip: pass(clip) as never, asset,
    track: timeline.tracks.find(track => track.id === clip.trackId) as never});
  const coEditConflicts = (['timing', 'visual', 'audio'] as const)
    .map(group => ({ group, record: groupClaims[group] }))
    .filter((item): item is { group: ClipCoEditingGroup; record: GroupClaimRecord } => Boolean(item.record?.conflict));
  const hasCoEditConflict = coEditConflicts.length > 0;
  const anyConflict = conflict || hasCoEditConflict;
  const soundActionsBlocked = Boolean(busy || dirty || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || audioWrite);
  const rectIssue = kind === 'audio' || clip.layout ? '' : timelineRectIssue(draft.rect, timeline);
  const roleEditable = draftContext?.audioRoleEditable === true && (['audio', 'video'] as readonly string[]).includes(String(kind));
  const envelopeEligible = asset?.hasAudio === true && (['audio', 'video'] as readonly string[]).includes(String(kind));
  const envelopeEditable = envelopeEligible && draftContext?.volumeEnvelopeEditable === true;
  const envelopeChanged = rawVolumeEnvelopeChanged(draft, savedRaw);
  // Dialogue analysis is bound to the saved position, so unsaved moves block it.
  const positionDirty = (['trackId', 'startFrame', 'durationFrames', 'sourceInFrame'] as const).some(key => String(draft[key]) !== String(savedRaw[key]));
  const envelopeCapture = controller.capture();
  const composition = useRef(new Map<string, VolumeToken>());
  const compositionPending = Boolean(state.compositionPending);
  const compositionKind = compositionPending ? controller.getPendingEnvelopeKind?.() ?? 'volume' : null;
  const volumeComposing = compositionKind === 'volume';
  function envelopeComposition(next: EnvelopeComposition): void {
    if (next.pending) {
      let token: VolumeToken | null | undefined = composition.current.get(next.session);
      if (!token) { token = controller.beginVolumeComposition(envelopeCapture) as never; if (token) composition.current.set(next.session, token); }
      if (token) controller.updateVolumeComposition(token as never, pass(next) as never);
    } else {
      const token = composition.current.get(next.session);
      if (token) { controller.endVolumeComposition(token); composition.current.delete(next.session); }
    }
  }
  function editEnvelope(value: VolumeEnvelopeValue, session?: string): void {
    const token = session === undefined ? envelopeCapture : composition.current.get(session);
    if (token && controller.editVolumeEnvelope(value, token)) {
      dirtyRef.current = true;
      ensureGroupClaimOnInput('volumeEnvelope');
    }
  }
  // Reuse the existing Inspector confirmation fence for the auxiliary tool.
  // It blocks implicit Save after compositionend without cancelling native IME.
  const duckingImeSubmit = useRef<ImeGuard | null>(null);
  function guardOpacityCompositionKey(event: React.KeyboardEvent<HTMLFormElement>): void {
    const native = event.nativeEvent, target = event.target as HTMLElement | null, testId = target?.getAttribute?.('data-testid') ?? '';
    const syntheticComposing = (event as unknown as { isComposing?: boolean }).isComposing === true;
    const duckingTarget = testId.startsWith('ducking-');
    if (duckingTarget && !duckingImeSubmit.current) duckingImeSubmit.current = createOpacityImeSubmitGuard();
    if (duckingImeSubmit.current?.keyDown({key: event.key, keyCode: native.keyCode, isComposing: native.isComposing === true || syntheticComposing,
      repeat: native.repeat === true || event.repeat === true, opacityTarget: duckingTarget,
      pending: controller.hasPendingComposition()})) event.stopPropagation();
  }
  function releaseOpacityCompositionKey(event: React.KeyboardEvent<HTMLFormElement>): void {
    duckingImeSubmit.current?.keyUp({key: event.key, keyCode: event.nativeEvent?.keyCode ?? event.keyCode, pending: controller.hasPendingComposition()});
  }
  function releaseOpacityCompositionClick(): void {
    duckingImeSubmit.current?.pointerDown(controller.hasPendingComposition());
  }
  const draftIssue = !envelopeEditable && envelopeChanged ? t('volume.envelope.unsupported') : !roleEditable && clipAudioRoleChanged(draft, savedRaw) ? t('audio.role.unsupportedChange') : clipDraftPatch(draft, clip.layout ? savedRaw.rect : undefined) ? '' : t('timeline.inspector.draftInvalid');
  function edit(key: EditKey, value: unknown): void {
    if (controller.edit(key as never, pass(value) as never)) {
      dirtyRef.current = true;
      ensureGroupClaimOnInput(String(key));
    }
  }
  function reset(): void {
    if (!draftAvailable || controller.hasPendingComposition()) return;
    releaseAllGroupClaims();
    void controller.discard(controller.capture());
  }
  async function save(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (duckingImeSubmit.current?.blocksSubmit()) return;
    if (controller.hasPendingComposition() || !mounted.current || busy || anyConflict || audioIssue || rectIssue || draftIssue) return;
    const touchedGroups = dirtyClipGroups(draft, savedRaw);
    for (const group of touchedGroups) {
      const existing = groupClaimsRef.current[group];
      if (existing?.status === 'acquired') continue;
      const promise = groupPromises.current[group]
        ?? claimGroupAtRevision(group, existing?.targetKind ?? clipGroupTargetKind(group), baselineRevision.current);
      const result = await promise;
      if (!mounted.current || result.status !== 'acquired') return;
    }
    const savedResult = await controller.save(onSave);
    if (mounted.current && savedResult && !controller.hasUnsaved()) {
      await releaseAllGroupClaims();
    }
  }

  function groupComparison(group: ClipCoEditingGroup) {
    const record = groupClaims[group];
    const groupConflict = record?.conflict;
    if (!groupConflict || groupConflict.kind !== 'revision_changed') {
      return { rows: [], conflictedFields: new Set<string>() };
    }
    const serverValues = (groupConflict.currentValues as Record<string, unknown> | null)
      ?? (refreshingConflict ? null : savedRaw as unknown as Record<string, unknown>);
    const fields = group === 'audio'
      ? ['gain', 'muted', 'fadeInFrames', 'fadeOutFrames', 'audioRole', 'volumeEnvelope']
      : group === 'visual'
        ? ['rect', 'transform', 'transitionIn', 'colour', 'opacity', 'blendMode']
        : ['name', 'trackId', 'startFrame', 'durationFrames', 'sourceInFrame'];
    return buildCoEditingComparison({
      localValues: draft as unknown as Record<string, unknown>,
      serverValues,
      baselineValues: baselineRawRef.current as unknown as Record<string, unknown>,
      fields,
      format: { fps: timeline.fps, t, formatNumber, trackName: trackNameById },
    });
  }

  const timingDiff = groupComparison('timing');
  const visualDiff = groupComparison('visual');
  const audioDiff = groupComparison('audio');

  function renderGroupConflict(group: ClipCoEditingGroup, rows: ReturnType<typeof groupComparison>['rows']): React.ReactNode {
    const record = groupClaims[group];
    if (!record?.conflict) return null;
    const groupLabel = t(`agent.coEdit.group.${group}`);
    return <MioCoEditingConflictCard
      conflict={record.conflict}
      groupLabel={groupLabel}
      rows={rows}
      refreshing={refreshingConflict}
      busy={record.busy || Boolean(busy) || state.submitting}
      testId={`coedit-conflict-${group}`}
      onAdoptMio={() => adoptMioForGroup(group)}
      onKeepMine={() => keepMineForGroup(group)}
      onReconcile={() => reconcileUnknownForGroup(group)}
      onCheckInMio={onOpenMioPanel}
    />;
  }

  // A crossfade saves both clips at once, so it waits for a clean, connected draft.
  const crossfadeBlocked = Boolean(compositionPending || busy || dirty || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || !envelopeEditable || audioWrite);
  // A transform keyframe is a saved edit too, so it also waits for a clean draft.
  const transformBlocked = Boolean(compositionPending || busy || dirty || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || visualWrite);
  const removalBlocked = Boolean(compositionPending || busy || dirty || state.submitting || state.candidate || !draftAvailable || !visible || Boolean(timingWrite || visualWrite || audioWrite));
  const removal = useClipRemoval({clip, scope: `${draftContext?.scope || timeline.projectId}:${timeline.id}:${timeline.revision}:${clip.id}`, disabled: removalBlocked,
    canRemove: () => mounted.current && visible && draftAvailable && !busy && !controller.hasPendingComposition() && !controller.hasUnsaved() && !controller.getState().candidate,
    onRemove, onRippleRemove});

  const activeDirtyGroups = dirty ? dirtyClipGroups(draft, savedRaw) : [];
  const anyMioWrite = Boolean(timingWrite || visualWrite || audioWrite);
  const footerStatusClass = anyConflict ? 'is-conflict' : dirty ? 'is-dirty' : 'is-saved';
  const footerStatusText = anyConflict
    ? t('agent.coEdit.unresolvedConflict')
    : dirty && anyMioWrite && activeDirtyGroups.length === 1
      ? t('agent.coEdit.groupDirty', { group: t(`agent.coEdit.group.${activeDirtyGroups[0]!}`) })
      : t(dirty ? 'timeline.inspector.unsaved' : 'timeline.inspector.synced');

  return <aside className="inspector clip-inspector edit-clip-inspector" data-testid="clip-inspector"><header className="inspector-heading"><Icon name={kind === 'audio' ? 'music' : 'film'} size={14} /><strong title={asset?.name || clip.name}>{asset?.name || clip.name || t('timeline.inspector.title')}</strong><Badge className="small-badge accent">{t('timeline.inspector.fixedAsset')}</Badge><ClipActionsMenu disabled={removalBlocked} disabledHint={dirty || state.candidate ? t('timeline.inspector.saveBeforeRemove') : undefined} onRemove={onRemove ? () => removal.request('remove') : undefined} onRippleRemove={onRippleRemove ? () => removal.request('ripple') : undefined} onSplit={onSplit} splitDisabled={splitDisabled} onShowAsset={onShowAsset} onReplaceSource={onReplaceSource ? () => setRequestedGroup(current => ({key: 'source', clipId: clip.id, version: (current?.version ?? 0) + 1})) : undefined} onPreview={onPreview} onReturnToSource={onReturnToSource} /></header>{removal.dialog}<ScrollArea className="edit-inspector-scroll" style={{flex:1,minHeight:0}}><form id="clip-properties-form" className="inspector-scroll clip-form" style={{overflow:'visible'}} onSubmit={save} onKeyDownCapture={guardOpacityCompositionKey} onKeyUpCapture={releaseOpacityCompositionKey} onPointerDownCapture={releaseOpacityCompositionClick}>{sequence && <ShotVersionBar sequence={sequence} />}<InspectorDraftDisclosure state={state}><ClipDraftRecovery state={state} disconnected={!draftAvailable} controller={controller} pending={Boolean(busy || compositionPending)} onOpenRequests={onOpenRequests} /></InspectorDraftDisclosure><InspectorGroups key={clip.id} requestedOpen={requestedGroup?.clipId === clip.id ? requestedGroup : undefined} defaultOpen={kind === 'audio' ? ['audio'] : ['basic','visual']}><InspectorGroup groupKey="basic" title={t('edit.group.basic')} initialOpen className="edit-inspector-basic" mioEditing={timingWrite ? { color: timingWrite.color, badgeTestId: 'mio-editing-badge-timing' } : null} hasConflict={Boolean(groupClaims.timing?.conflict)} conflict={renderGroupConflict('timing', timingDiff.rows)}><Label className="field-label" htmlFor="clip-name">{t('timeline.inspector.name')}</Label><Input id="clip-name" data-coedit-field-conflict={timingDiff.conflictedFields.has('name') ? 'true' : undefined} value={draft.name} maxLength={200} onChange={e => edit('name', e.target.value)} /><Label className="field-label" htmlFor="clip-track">{t('timeline.inspector.track')}</Label><WorkbenchSelect id="clip-track" data-testid="clip-track" value={draft.trackId} onChange={e => edit('trackId', e.target.value)}>{timeline.tracks.filter(track => track.kind === (kind === 'audio' ? 'audio' : 'video')).map(track => <option key={track.id} value={track.id}>{trackOptionLabel(track)}</option>)}</WorkbenchSelect><div className="field-row"><div><Label className="field-label" htmlFor="clip-start">{t('timeline.inspector.start')}</Label><Input id="clip-start" data-testid="clip-start" data-coedit-field-conflict={timingDiff.conflictedFields.has('startFrame') ? 'true' : undefined} type="number" min="0" max="17999" step="1" required value={draft.startFrame} onChange={e => edit('startFrame', e.target.value)} /></div><div><Label className="field-label" htmlFor="clip-duration">{t('timeline.inspector.duration')}</Label><Input id="clip-duration" data-testid="clip-duration" data-coedit-field-conflict={timingDiff.conflictedFields.has('durationFrames') ? 'true' : undefined} type="number" min="1" max="18000" step="1" required value={draft.durationFrames} onChange={e => edit('durationFrames', e.target.value)} /></div></div><Label className="field-label" htmlFor="clip-source-in">{t('timeline.inspector.sourceIn')}</Label><Input id="clip-source-in" data-testid="clip-source-in" data-coedit-field-conflict={timingDiff.conflictedFields.has('sourceInFrame') ? 'true' : undefined} type="number" min="0" max={kind === 'image' ? 0 : sourceFrameCount(asset?.duration) === null ? undefined : Math.max(0, (sourceFrameCount(asset!.duration) ?? 0) - 1)} step="1" required disabled={kind === 'image'} value={draft.sourceInFrame} onChange={e => edit('sourceInFrame', e.target.value)} /></InspectorGroup>{kind !== 'audio' && <InspectorGroup groupKey="visual" title={t('edit.group.visual')} initialOpen mioEditing={visualWrite ? { color: visualWrite.color, badgeTestId: 'mio-editing-badge-visual' } : null} hasConflict={Boolean(groupClaims.visual?.conflict)} conflict={renderGroupConflict('visual', visualDiff.rows)}>{!clip.layout && <><Separator className="section-divider" /><div className="section-heading"><span>{t('timeline.inspector.rect')}</span><span>{timeline.width} × {timeline.height}</span></div><div className="rect-grid">{[['x','X'],['y','Y'],['width',t('timeline.inspector.width')],['height',t('timeline.inspector.height')]].map(([key, label]) => <div key={key}><Label className="field-label" htmlFor={`clip-${key}`}>{label} (px)</Label><Input id={`clip-${key}`} data-testid={`clip-${key}`} data-coedit-field-conflict={visualDiff.conflictedFields.has('rect') ? 'true' : undefined} type="number" min={['x','y'].includes(key) ? 0 : 2} max={['x','width'].includes(key) ? timeline.width : timeline.height} step="2" required value={(draft.rect as Record<string, unknown>)[key] as string | number} onChange={e => edit('rect', { ...draft.rect, [key]: e.target.value })} /></div>)}</div>{rectIssue && <p className="notice warning" role="alert">{renderMessage(timelineRectMessage(draft.rect, timeline))}</p>}</>}{onSetTransform && <ClipTransformControls key={`${clip.id}:${transformFrame}:${JSON.stringify(clip.transform ?? null)}`} clip={pass(clip)} frame={transformFrame} disabled={transformBlocked} disabledReason={dirty || state.candidate ? t('clip.transform.saveFirst') : undefined} onSetTransform={transform => onSetTransform(clip.id, transform)} />}{onSetTransition && <ClipTransitionControls key={`${clip.id}:${JSON.stringify(clip.transitionIn ?? null)}:${transitionContext.hasCut}:${transitionContext.maxFrames}`} clip={pass(clip)} context={transitionContext} disabled={transformBlocked} disabledReason={dirty || state.candidate ? t('clip.transition.saveFirst') : undefined} onSetTransition={transition => onSetTransition(clip.id, transition)} />}<ClipLutControls key={`${draftContext?.scope || timeline.projectId}:${clip.id}:${clip.assetId}:${asset?.sha256 || ''}`} context={{ scope: draftContext?.scope || timeline.projectId, projectId: timeline.projectId, timelineId: timeline.id, clipId: clip.id, assetId: clip.assetId, assetSha256: asset?.sha256 || '', kind, mimeType: asset?.mimeType, colour: draft.colour, blocked: Boolean(busy || state.submitting || state.candidate || anyConflict || !draftAvailable || !visible || visualWrite) }} kind={pass(kind)}  onEdit={edit} rpc={rpc} Select={WorkbenchSelect} /></InspectorGroup>}<InspectorGroup groupKey="audio" title={t('edit.group.audio')} initialOpen={kind === 'audio'} className="edit-inspector-audio" mioEditing={audioWrite ? { color: audioWrite.color, badgeTestId: 'mio-editing-badge-audio' } : null} hasConflict={Boolean(groupClaims.audio?.conflict)} conflict={renderGroupConflict('audio', audioDiff.rows)} headerAction={soundEntries && onToggleClipMute ? <Button variant="ghost" type="button" role="switch" aria-checked={clip.muted === true} aria-label={t(clip.muted === true ? 'clipSound.unmute' : 'clipSound.mute')} data-testid="clip-mute-toggle" className={`clip-mute-toggle ${clip.muted === true ? 'is-muted' : ''}`} disabled={soundActionsBlocked} title={t(clip.muted === true ? 'clipSound.unmute' : 'clipSound.mute')} onClick={() => onToggleClipMute(clip.id, !(clip.muted === true))}>{clip.muted === true ? <VolumeX size={14} /> : <Volume2 size={14} />}</Button> : undefined} footer={soundEntries ? <div className="clip-audio-actions" data-testid="clip-audio-actions">{onSeparateSound && <Button variant="outline" size="sm" type="button" data-testid="clip-separate-sound" disabled={soundActionsBlocked} onClick={() => onSeparateSound(clip.id)}><Icon name="music" size={13} />{t('clipSound.separate')}</Button>}{onSaveClipAudio && <Button variant="outline" size="sm" type="button" data-testid="clip-save-as-audio" disabled={soundActionsBlocked} onClick={() => onSaveClipAudio(clip.id)}><Icon name="download" size={13} />{t('clipSound.saveAsAudio')}</Button>}</div> : undefined}><ClipAudioControls section="volume" asset={asset} kind={pass(kind)} draft={pass(draft)} onEdit={pass(edit)} issue={audioIssue} conflictedFields={audioDiff.conflictedFields} />{(envelopeEligible || Object.prototype.hasOwnProperty.call(draft, 'volumeEnvelope')) && <section data-testid="clip-volume-envelope"><ClipVolumeEnvelopeControls value={draft.volumeEnvelope} proposedDuration={Number.isFinite(Number(draft.durationFrames)) ? Number(draft.durationFrames) : 0} disabled={!volumeComposing && (!envelopeEditable || compositionPending || Boolean(busy || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || audioWrite))} onEdit={pass(editEnvelope)} onCompositionChange={pass(envelopeComposition)} />{envelopeEditable && <ClipDialogueDuckingControls clip={pass<DuckingClip>(clip)} clips={pass<DuckingClip[]>(timeline.clips ?? [])} tracks={pass<DuckingTrack[]>(timeline.tracks)} timelineRevision={timeline.revision} disabled={compositionPending || Boolean(busy || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || audioWrite)} blockedReason={positionDirty ? t('ducking.auto.positionDirty') : undefined} hasEnvelope={Boolean(draft.volumeEnvelope)} readWaveform={request => rpc('asset.waveform.get', { projectId: timeline.projectId, assetId: request.assetId, sourceStartFrame: request.sourceStartFrame, sourceEndFrame: request.sourceEndFrame, points: request.points })} requestWaveform={assetId => rpc('asset.waveform.request', { projectId: timeline.projectId, assetId })} onApply={value => editEnvelope(pass(value))} />}{compositionPending && <p role="status">{t('volume.envelope.composing')}</p>}</section>}<ClipAudioControls section="fades" asset={asset} kind={pass(kind)} draft={pass(draft)} onEdit={pass(edit)} issue={audioIssue} conflictedFields={audioDiff.conflictedFields} />{envelopeEligible && crossfadeCandidates && <ClipCrossfadeControls candidates={crossfadeCandidates} onCrossfade={onCrossfade} disabled={crossfadeBlocked} disabledReason={dirty || state.candidate ? t('crossfade.saveFirst') : undefined} />}{loudnessContext && <ClipLoudnessObservation context={pass(loudnessContext)} draftController={controller} draftState={state} visible={visible} onUnauthorized={onLoudnessUnauthorized} />}<details className="clip-audio-help clip-audio-classification"><summary>{t('round3.audio.classification')}</summary><ClipAudioRoleControls Select={WorkbenchSelect} kind={pass(kind)} value={draft.audioRole} editable={roleEditable} blocked={Boolean(busy || state.submitting || state.businessPending || state.candidate || anyConflict || !draftAvailable || !visible || audioWrite)} onEdit={value => edit('audioRole', value)} /></details></InspectorGroup><InspectorGroup groupKey="source" title={t('edit.group.source')}><div className="clip-source"><span>{t('timeline.inspector.frozen')}</span><strong title={asset?.name}>{asset?.name || clip.assetId}</strong>{staleSource && <p className="clip-source-stale" data-testid="clip-source-stale-note" role="status">{staleSourceSentence(pass(staleSource), locale)}</p>}{sourceDescription && <p className="clip-source-description" data-testid="clip-source-description">{sourceDescription}</p>}{onReturnToSource && <Button variant="outline" size="sm" type="button" className="button small return-to-source" data-testid="return-to-source" disabled={busy} onClick={onReturnToSource}><Icon name="left" size={13} />{t('timeline.inspector.returnSource')}</Button>}<Button variant="ghost" size="sm" type="button" className="text-button" data-testid="preview-clip-source" onClick={onPreview}><Icon name="play" size={13} />{t('timeline.inspector.previewSource')}</Button></div>{onReplaceSource && <ClipSourceReplacement context={{ ...replacementContext, timeline, clipId: clip.id, dirty }} getDirty={() => dirtyRef.current} onReplace={pass(onReplaceSource)} onOpenRequests={pass(onOpenRequests)} />}</InspectorGroup></InspectorGroups>{conflict && !hasCoEditConflict && <div className="notice warning" role="alert">{t('timeline.inspector.conflict')}{state.canRebase && <Button variant="ghost" size="sm" type="button" data-testid="clip-draft-rebase" disabled={compositionPending || busy || state.submitting || !draftAvailable} onClick={() => { if (mounted.current) controller.rebaseDraft(); }}>{t('timeline.inspector.rebase')}</Button>}<Button variant="ghost" size="sm" type="button" data-testid="clip-draft-reload" disabled={compositionPending || busy || state.submitting || !draftAvailable} onClick={reset}>{t('timeline.inspector.reload')}</Button></div>}{dirty && draftIssue && <p className="notice warning" role="alert">{draftIssue}</p>}</form></ScrollArea><footer className="edit-inspector-save" onKeyDownCapture={guardOpacityCompositionKey} onKeyUpCapture={releaseOpacityCompositionKey} onPointerDownCapture={releaseOpacityCompositionClick}><span className={footerStatusClass} role="status" data-testid="clip-inspector-status">{footerStatusText}</span><Button variant="ghost" size="sm" type="button" disabled={!dirty || compositionPending || busy || state.submitting || !draftAvailable} onClick={reset}>{t('timeline.inspector.discard')}</Button><Button size="sm" className="button primary" data-testid="save-clip" disabled={compositionPending || !dirty || busy || state.submitting || Boolean(state.candidate) || !draftAvailable || anyConflict || Boolean(audioIssue || rectIssue || draftIssue)} type="submit" form="clip-properties-form">{t('timeline.inspector.save')}</Button></footer></aside>;
}

function ClipLoudnessObservation({ context, draftController, draftState, visible, onUnauthorized }: { context: () => Record<string, unknown> & { executionScope: string }; draftController: ClipDraftController; draftState: ClipDraftState; visible: boolean; onUnauthorized?: () => unknown }): React.ReactElement {
  const [staged, setStaged] = useState<{ executionScope: string; gain: number } | null>(null);
  const scopedContext = () => { const base = context(); return { ...base, executionScope: `${base.executionScope}:${JSON.stringify(draftController.capture())}` }; };
  const getContext = () => clipLoudnessDraftContext(pass(scopedContext()) as never, draftController.getState(), visible);
  const loudness = useTimelineClipLoudness({ context: pass(clipLoudnessDraftContext(pass(scopedContext()) as never, draftState, visible)), getContext,
    read: (input, options) => rpc('timeline.clip.loudness', input, options), onUnauthorized,
    onMatchGain(gain) {
      if (!stageClipLoudnessGain(draftController, getContext(), gain)) return false;
      setStaged({ executionScope: context().executionScope, gain });
      return true;
    } });
  const { t } = useI18n();
  const showStaged = staged && staged.executionScope === context().executionScope && draftState.dirty && Number(draftState.raw.gain) === staged.gain;
  return <><TimelineClipLoudness loudness={loudness} />{showStaged && <p className="clip-loudness-staged input-hint" data-testid="clip-loudness-staged" role="status">{t('audio.loudness.match.staged')}</p>}</>;
}
