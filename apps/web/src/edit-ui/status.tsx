import React from 'react';
import './edit-ui.css';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {editUiTrackBadge} from './projection.ts';
import type {EditUiClipStatus, EditUiTimelineTrack, EditUiVersion} from './projection.ts';

/** Title plus the status suffix the design puts after a main-track clip name:
 * `· V2` while following the board, `· 锁定 V1` when locked, and
 * `· 待生成（占位 N 秒）` for a placeholder. */
export function EditUiClipTitle({title, status}: {readonly title: React.ReactNode; readonly status?: EditUiClipStatus | undefined}): React.ReactElement {
  const {t, formatNumber} = useI18n();
  let suffix: string | null = null;
  if (status?.kind === 'placeholder') {
    suffix = t('editUi.clip.placeholder', {seconds: formatNumber(status.durationSeconds, {maximumFractionDigits: 2, useGrouping: false})});
  } else if (status?.kind === 'follow' && status.version) {
    suffix = t('editUi.clip.version', {version: status.version.number});
  } else if (status?.kind === 'locked' && status.version) {
    suffix = t('editUi.clip.locked', {version: status.version.number});
  }
  return <>{title}{suffix !== null && <span className="edit-ui-clip-status" data-status={status?.kind}>{suffix}</span>}</>;
}

export interface EditUiVersionVersions {
  readonly boardVersion: EditUiVersion | null;
  readonly appliedVersion: EditUiVersion | null;
}

/** Dropdown and status text for a shot's version mode. */
export function editUiVersionLabel(t: ReturnType<typeof useI18n>['t'], mode: 'follow' | 'locked', versions: EditUiVersionVersions): string {
  const version = mode === 'follow' ? versions.boardVersion ?? versions.appliedVersion : versions.appliedVersion ?? versions.boardVersion;
  return mode === 'follow' ? t('editUi.version.follow', {version: version?.number ?? 0}) : t('editUi.version.locked', {version: version?.number ?? 0});
}

/** Binds a version-mode choice to the concrete version ID it selects. */
export function editUiVersionChoice(versions: EditUiVersionVersions, mode: 'follow' | 'locked'): {readonly mode: 'follow' | 'locked'; readonly versionId: string | null} {
  return {mode, versionId: mode === 'follow' ? versions.boardVersion?.id ?? null : versions.appliedVersion?.id ?? null};
}

/** Track picker label: the main track carries its `V1 · 主轨` marker, the other
 * default track names keep the existing picture/overlay/music labels. */
export function editUiTrackPickerLabel(t: ReturnType<typeof useI18n>['t'], track: {readonly id: string; readonly kind?: string; readonly name?: string},
  tracks: readonly EditUiTimelineTrack[], mainTrackId: string | null): string {
  if (track.id === mainTrackId) return t('editUi.track.mainMarker', {badge: editUiTrackBadge(tracks, track.id) ?? ''});
  return /^(Video|Audio)\s*\d+$/i.test(track.name ?? '') ? t(track.kind === 'audio' ? 'edit.track.music' : track.id === tracks.find(item => item.kind === 'video')?.id ? 'edit.track.picture' : 'edit.track.overlay') : track.name ?? '';
}

/** The properties panel top block: shot identity, board reveal, and version mode. */
export interface EditUiInspectorSequence extends EditUiVersionVersions {
  /** Track the shot segment sits on; the panel labels it `V1 · 主轨` when it is the main track. */
  readonly mainTrackId: string | null;
  readonly shotNumber: string;
  readonly shotName: string;
  readonly versionMode: 'follow' | 'locked';
  /** Reveals the shot on the board; the caller owns navigation. */
  readonly onRevealShot?: (() => unknown) | undefined;
  /** A version choice only reports intent; UI-E2 performs and confirms the write. */
  readonly onVersionChoice?: ((choice: {readonly mode: 'follow' | 'locked'; readonly versionId: string | null}) => unknown) | undefined;
}
