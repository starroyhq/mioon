import {TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
// Shared byte guard and exact expression for both migration/index and reader.
// An unguarded JSON expression can make malformed legacy rows break startup.
export const INSPECTION_ROW_LIMITS = Object.freeze({projects: 16 * 1024, assets: 16 * 1024, shots: 32 * 1024,
  nodes: 32 * 1024, edges: 16 * 1024, versions: 64 * 1024, jobs: 128 * 1024, timelines: TIMELINE_RESPONSE_BYTES});
export const INSPECTION_VERSION_ASSET_EXPRESSION = `CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.versions}
  THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.assetId')='text' AND length(CAST(json_extract(data,'$.assetId') AS BLOB))=36
    THEN json_extract(data,'$.assetId') END END END`;
