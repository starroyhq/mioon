// Frozen SQL interpolation inputs from commit 0343ed390a85c319210b5f179180cf9c8c3985c2.
// These belong to the through24 constructor, not to the current media/reader
// configuration. Future versions must use their own migration and constants.
export const INSPECTION_ROW_LIMITS = Object.freeze({versions: 64 * 1024});
export const INSPECTION_VERSION_ASSET_EXPRESSION = `CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.versions}
  THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data,'$.assetId')='text' AND length(CAST(json_extract(data,'$.assetId') AS BLOB))=36
    THEN json_extract(data,'$.assetId') END END END`;
export const FRAME_PROFILE_ID = 'local-png-1024-v1';
export const FRAME_SELECTION_RULE = 'first-pts-at-or-after-v1';
export const FRAME_LIMITS = Object.freeze({
  inputBytes:4096, snapshotBytes:4096, receiptBytes:4096, taskBytes:16384,
  requestBytes:12288, responseBytes:4096, queuedPerProject:2, queuedGlobal:8,
  tasksPerProject:256, tasksGlobal:2048, requestsPerTask:16,
  resultBytes:4*1024*1024, resultMaxEdge:1024,
});
