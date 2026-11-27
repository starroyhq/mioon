import type {DatabaseSync} from 'node:sqlite';
import {originalVideoFrameRate, type ProbeResult} from './media-probe.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {timelineRecordFormatOf} from './timeline-record-format.ts';

export function exposesProjectAssetFrameRate(db: DatabaseSync, mimeType: unknown): boolean {
  return process.env.MIOON_FORMAT6_DEV === '1' && typeof mimeType === 'string' && mimeType.startsWith('video/') &&
    timelineRecordFormatOf(db) === FORMAT6_PROJECT_SCHEMA_VERSION;
}

export function measuredProjectAssetFrameRate(db: DatabaseSync, mimeType: string, probe: ProbeResult) {
  return exposesProjectAssetFrameRate(db, mimeType) ? {videoFrameRate: originalVideoFrameRate(probe)} : {};
}

/** A preexisting video can have no saved rate. Project reads surface that as
 * unknown without accessing the media or mutating immutable import evidence. */
export function projectAssetFrameRateView(db: DatabaseSync, asset: Record<string, unknown>): Record<string, unknown> {
  const hasRate = Object.hasOwn(asset, 'videoFrameRate');
  if (exposesProjectAssetFrameRate(db, asset.mimeType)) return hasRate ? asset : {...asset, videoFrameRate: null};
  if (!hasRate) return asset;
  const {videoFrameRate: _videoFrameRate, ...legacyAsset} = asset;
  return legacyAsset;
}
