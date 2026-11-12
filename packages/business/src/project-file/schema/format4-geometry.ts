import type {DatabaseSync} from 'node:sqlite';
import {TIMELINE_RESPONSE_BYTES} from '../../../../contracts/src/timeline-replacement.ts';
import {projectFileError} from '../errors.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION} from './databases.ts';

// On-disk discriminators frozen by G. K only registers the accepted storage
// profiles. G/FT validate geometry and project it using the original basis.
const basisPresets = new Set([
  'portrait_720', 'portrait_1080', 'landscape_720', 'landscape_1080', 'square_720', 'square_1080',
  'landscape_4_3_720', 'landscape_4_3_1080', 'portrait_3_4_720', 'portrait_3_4_1080', 'ultrawide_720', 'ultrawide_1080',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const basis = (value: unknown): boolean => typeof value === 'string' && basisPresets.has(value);

export function isTimelineGeometryProfileAllowed(value: unknown, formatVersion: number): boolean {
  if (!record(value)) return false;
  const v2 = formatVersion === FORMAT4_PROJECT_SCHEMA_VERSION;
  if (Array.isArray(value.clips)) {
    for (const clip of value.clips) {
      if (!record(clip) || !Object.hasOwn(clip, 'layout')) continue;
      const layout = clip.layout;
      if (!v2 || !record(layout) || Object.keys(layout).length !== 2 ||
          layout.profileId !== 'mioon-clip-layout-v2' || !basis(layout.basisPresetId)) return false;
    }
  }
  const subtitles = value.subtitles;
  if (subtitles === undefined || subtitles === null) return true;
  if (!record(subtitles)) return false;
  if (subtitles.profileId === 'bottom_cjk_relative_v2') {
    return v2 && Object.keys(subtitles).length === 3 && Array.isArray(subtitles.cues) && basis(subtitles.basisPresetId);
  }
  return !Object.hasOwn(subtitles, 'basisPresetId') && (!Object.hasOwn(subtitles, 'profileId') || subtitles.profileId === 'bottom_cjk_v1');
}

export function assertProjectTimelineGeometryProfile(db: DatabaseSync, schema: 'main' | 'project', formatVersion: number): void {
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=${TIMELINE_RESPONSE_BYTES} THEN data END AS data FROM ${schema}.timelines LIMIT 2`).all();
  const invalid = () => projectFileError('PROJECT_INVALID', {database: 'project', reason: 'metadata'});
  if (rows.length > 1) throw invalid();
  for (const row of rows) {
    if (typeof row.data !== 'string') throw invalid();
    let decoded: unknown;
    try { decoded = JSON.parse(row.data); } catch { throw invalid(); }
    if (!isTimelineGeometryProfileAllowed(decoded, formatVersion)) throw invalid();
  }
}
