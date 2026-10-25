import { message, renderMessage, translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/types.ts';
// A timeline clip freezes the generated version it was created from. When its shot later selects another version the
// clip keeps playing the old one, so the storyboard export and the timeline export silently disagree. These helpers
// find such clips so the timeline and inspector can say so; nothing here changes a clip.
export interface FreshnessClip { id: string; assetId?: string | null; shotId?: string | null; versionId?: string | null }
export interface FreshnessShot { id: string; title?: string; selectedVersionId?: string | null }
export interface FreshnessVersion { id: string; assetId?: string | null; shotId?: string; number?: number }
export interface StaleClipSource {
  clipId: string; shotId: string; shotTitle: string; shotTitleMissing?: boolean;
  versionId: string; versionNumber: number | null;
  selectedVersionId: string; selectedVersionNumber: number | null;
}

// Clips created from the storyboard or the library carry only the asset they froze, not the version they came from,
// so the version is found through that asset (every generated version owns its own asset). Explicit provenance wins.
export function clipVersionOf(clip: FreshnessClip, versions: readonly FreshnessVersion[]): { versionId: string; shotId: string } | null {
  const version = clip.versionId ? versions.find(item => item.id === clip.versionId) : clip.assetId ? versions.find(item => item.assetId === clip.assetId) : undefined;
  const versionId = clip.versionId ?? version?.id, shotId = clip.shotId ?? version?.shotId;
  return versionId && shotId ? { versionId, shotId } : null;
}

export function staleClipSources(clips: readonly FreshnessClip[], shots: readonly FreshnessShot[], versions: readonly FreshnessVersion[]): Map<string, StaleClipSource> {
  const stale = new Map<string, StaleClipSource>();
  if (!clips.length || !shots.length) return stale;
  const shotById = new Map(shots.map(shot => [shot.id, shot] as const));
  const numberOf = (id: string) => { const number = versions.find(version => version.id === id)?.number; return typeof number === 'number' ? number : null; };
  for (const clip of clips) {
    const origin = clipVersionOf(clip, versions);
    if (!origin) continue;
    const shot = shotById.get(origin.shotId);
    if (!shot?.selectedVersionId || shot.selectedVersionId === origin.versionId) continue;
    stale.set(clip.id, { clipId: clip.id, shotId: shot.id, shotTitle: shot.title || '镜头', ...(!shot.title ? { shotTitleMissing: true } : {}),
      versionId: origin.versionId, versionNumber: numberOf(origin.versionId),
      selectedVersionId: shot.selectedVersionId, selectedVersionNumber: numberOf(shot.selectedVersionId) });
  }
  return stale;
}

export function staleSourceSentence(stale: StaleClipSource, locale: Locale = 'zh-Hans'): string {
  const label = (number: number | null) => number === null ? translate(locale, 'timeline.source.otherVersion') : `V${number}`;
  return renderMessage(locale, message('timeline.source.stale', { title: stale.shotTitleMissing ? translate(locale, 'timeline.source.unnamedShot') : stale.shotTitle, selected: label(stale.selectedVersionNumber), original: label(stale.versionNumber) }));
}

// The board's view of the timeline. A shot is on the timeline when one of its versions backs a clip on any track, the
// same provenance timeline.shots.append uses to skip placed shots. Stale placements come first, then by position, so
// "view in editing" lands on the clip that needs attention.
export interface PlacedFreshnessClip extends FreshnessClip { trackId?: string; startFrame?: number }
export interface ShotTimelinePlacement { clipId: string; trackId: string | null; startFrame: number; versionId: string; versionNumber: number | null; stale: boolean }
export interface ShotTimelineStatus { shotId: string; stale: boolean; placements: ShotTimelinePlacement[] }
export function shotTimelineStatuses(clips: readonly PlacedFreshnessClip[], shots: readonly FreshnessShot[], versions: readonly FreshnessVersion[]): Map<string, ShotTimelineStatus> {
  const statuses = new Map<string, ShotTimelineStatus>(), shotById = new Map(shots.map(shot => [shot.id, shot] as const));
  for (const clip of clips) {
    const origin = clipVersionOf(clip, versions), shot = origin ? shotById.get(origin.shotId) : undefined;
    if (!origin || !shot) continue;
    const stale = Boolean(shot.selectedVersionId && shot.selectedVersionId !== origin.versionId), number = versions.find(version => version.id === origin.versionId)?.number;
    const status = statuses.get(shot.id) ?? { shotId: shot.id, stale: false, placements: [] };
    status.placements.push({ clipId: clip.id, trackId: clip.trackId ?? null, startFrame: clip.startFrame ?? 0, versionId: origin.versionId, versionNumber: typeof number === 'number' ? number : null, stale });
    status.stale ||= stale; statuses.set(shot.id, status);
  }
  for (const status of statuses.values()) status.placements.sort((a, b) => Number(b.stale) - Number(a.stale) || a.startFrame - b.startFrame);
  return statuses;
}
// What timeline.shots.append would add, in the given (storyboard) order: shots not placed yet that have a selected version.
export function appendableShots<T extends FreshnessShot>(shots: readonly T[], statuses: ReadonlyMap<string, ShotTimelineStatus>): T[] {
  return shots.filter(shot => shot.selectedVersionId && !statuses.has(shot.id));
}
// Same lane name as the timeline header: V1 is the lowest video track and default track names read as picture/overlay.
export interface LaneTrack { id: string; kind: string; name: string; orderIndex: number }
export function videoLaneLabel(tracks: readonly LaneTrack[], trackId: string | null, locale: Locale = 'zh-Hans'): string | null {
  const video = tracks.filter(track => track.kind === 'video').sort((a, b) => a.orderIndex - b.orderIndex), index = video.findIndex(track => track.id === trackId);
  if (index < 0) return null;
  const name = /^(Video|Audio)\s*\d+$/i.test(video[index]!.name) ? translate(locale, index === 0 ? 'edit.track.picture' : 'edit.track.overlay') : video[index]!.name;
  return `V${index + 1} ${name}`;
}

export type SourceRefreshSkipReason = 'NOT_GENERATED' | 'NO_SELECTION' | 'UP_TO_DATE' | 'SOURCE_TOO_SHORT';
export interface SourceRefreshSkip { clipId: string; reason: SourceRefreshSkipReason; shotId?: string; fromVersionId?: string; toVersionId?: string; shortByFrames?: number }
const SKIP_REASONS: readonly unknown[] = ['NOT_GENERATED', 'NO_SELECTION', 'UP_TO_DATE', 'SOURCE_TOO_SHORT'];
// A NOTHING_TO_REFRESH refusal lists its skips in error details. They are only displayed, so keep the well-formed rows.
export function sourceRefreshSkips(value: unknown): SourceRefreshSkip[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((row): row is SourceRefreshSkip => typeof row === 'object' && row !== null && typeof (row as { clipId?: unknown }).clipId === 'string' && SKIP_REASONS.includes((row as { reason?: unknown }).reason));
}
export interface SourceRefreshContext { clips: readonly { id: string; name?: string }[]; shots: readonly FreshnessShot[]; versions: readonly FreshnessVersion[]; fps: number }
export function refreshSkipSentence(skip: SourceRefreshSkip, context: SourceRefreshContext, locale: Locale = 'zh-Hans'): string {
  const shot = context.shots.find(item => item.id === skip.shotId)?.title || translate(locale, 'timeline.source.unnamedShot');
  if (skip.reason === 'SOURCE_TOO_SHORT') {
    const number = context.versions.find(version => version.id === skip.toVersionId)?.number;
    // Round the shortfall up so a one-frame gap never reads as "0 seconds".
    const seconds = Math.ceil((skip.shortByFrames ?? 0) / (context.fps || 30) * 10) / 10;
    return renderMessage(locale, message('timeline.sync.skip.tooShort', { shot, version: typeof number === 'number' ? `V${number}` : translate(locale, 'timeline.source.otherVersion'), seconds }));
  }
  if (skip.reason === 'NO_SELECTION') return renderMessage(locale, message('timeline.sync.skip.noSelection', { shot }));
  if (skip.reason === 'UP_TO_DATE') return renderMessage(locale, message('timeline.sync.skip.upToDate', { shot }));
  return renderMessage(locale, message('timeline.sync.skip.notGenerated', { clip: context.clips.find(item => item.id === skip.clipId)?.name || translate(locale, 'timeline.view.mediaClip') }));
}
// Known outcomes of the two bridges get their own wording; anything else keeps the shell's generic error text.
export function shotSyncErrorMessage(error: unknown): ReturnType<typeof message> | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'NOTHING_TO_REFRESH') return message('timeline.sync.error.nothingToRefresh');
  if (code === 'NOTHING_TO_APPEND') return message('timeline.sync.error.nothingToAppend');
  if (code === 'TIMELINE_LIMIT') return message('timeline.sync.error.limit');
  if (code === 'TRACK_NOT_FOUND') return message('timeline.sync.error.noVideoTrack');
  if (typeof code === 'string' && ['CLIP_NOT_FOUND', 'INVALID_VERSION', 'ASSET_HASH_MISMATCH', 'SOURCE_BOUNDS', 'INVALID_CLIP_TYPE', 'NOT_FOUND'].includes(code)) return message('timeline.sync.error.changed');
  if (code === 'RESTORE_OPERATION_UNAVAILABLE') return message('timeline.sync.restoredUnavailable');
  return null;
}
