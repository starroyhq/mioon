import {isTimelineExportAudioOutcome,isTimelineExportFloatSnapshot} from '@mioon/contracts/timeline-export-float';
import {floatSnapshotSha256} from './timeline-float-outcome.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {timelineDeliveryContentDisposition, timelineRenderDeliveryFields} from '@mioon/contracts/timeline-delivery';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RENDER_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value);
const bounded = (column: string, bytes: number): string => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END AS ${column}`;
const identity = (column: string): string => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
// The worker publishes a fresh, non-overwriting output under this exact
// existing path. Bind the named artifact to its export as well as its asset ID;
// otherwise swapping two same-project output pointers could pass the graph.
// No normalization or renaming is performed, and legacy routes do not use it.
function ownsPublishedOutputPath(relativePath: unknown, exportId: string): relativePath is string {
  const prefix = `media/export-${exportId}-`, suffix = '.mp4';
  return typeof relativePath === 'string' && relativePath.startsWith(prefix) && relativePath.endsWith(suffix) &&
    relativePath.length === prefix.length + 36 + suffix.length && uuid(relativePath.slice(prefix.length, -suffix.length));
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** The adapters are trusted backend wiring to the existing runtime validators.
 * Their return values remain unknown until checked here; no JS barrel or graph
 * implementation is pulled into the typed module. */
export interface TimelineDeliveryReadGuards {
  isTimelineRenderRecord(value: unknown, input: Readonly<Record<string, unknown>>): boolean;
  readOwnedAsset(projectId: string, assetId: string): unknown;
}

export interface TimelineDeliveryDownload {
  readonly exportId: string;
  readonly assetId: string;
  readonly projectId: string;
  readonly relativePath: string;
  readonly mimeType: 'video/mp4';
  readonly contentDisposition: string;
  /** Backend-only change fence, never included in the HTTP response. */
  readonly identityDigest: string;
}

/** Identity-only download syntax. A filename, destination or path is never
 * accepted as a caller-controlled input. Legacy media uses its existing path. */
export function timelineDeliveryDownloadIdentity(url: URL): {assetId: string; exportId: string} | null {
  const assetId = url.pathname.slice('/media/'.length);
  const keys = [...url.searchParams.keys()];
  const exportId = url.searchParams.get('exportId');
  if (url.hash || url.username || url.password || !url.pathname.startsWith('/media/') || !uuid(assetId) || !uuid(exportId) ||
      keys.length !== 2 || keys.filter(key => key === 'download').length !== 1 || keys.filter(key => key === 'exportId').length !== 1 ||
      url.searchParams.get('download') !== '1') return null;
  return {assetId, exportId};
}

/** Backend-only retained identity. The raw checked values never enter an RPC
 * response. Download retains its legacy acceptance rules; byte analysis adds
 * its stricter size/hash requirements after this shared provenance gate. */
export interface TimelineExportOutput {
  readonly exportId: string;
  readonly assetId: string;
  readonly projectId: string;
  readonly relativePath: string;
  readonly record: Readonly<Record<string, unknown>>;
  readonly asset: Readonly<Record<string, unknown>>;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly identityDigest: string;
}

interface OutputRequest {exportId: string; assetId?: string; projectId?: string}

/** The common bounded provenance gate. No current timeline or source lookup. */
function readTimelineExportOutputCore(
  db: DatabaseSync,
  requested: OutputRequest,
  guards: TimelineDeliveryReadGuards,
  requireName: boolean,
): TimelineExportOutput | null {
  let outer = false;
  try {
    outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    // Analysis supplies a project scope. The SQL relation is checked before
    // any export payload is read, including a corrupt foreign JSON document.
    if (requested.projectId !== undefined && !db.prepare('SELECT 1 FROM projects WHERE id=? LIMIT 1').get(requested.projectId)) return null;
    const row: unknown = db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data', RENDER_BYTES)} FROM exports WHERE id=?${requested.projectId === undefined ? '' : ' AND projectId=?'} LIMIT 1`)
      .get(...requested.projectId === undefined ? [requested.exportId] : [requested.exportId, requested.projectId]);
    if (!object(row) || row.id !== requested.exportId || !uuid(row.projectId)) return null;
    const projectId = row.projectId;
    const record = parse(row.data);
    if (!object(record) || record.id !== requested.exportId || record.projectId !== projectId ||
        record.mode !== 'timeline' || record.purpose !== 'export' || record.status !== 'succeeded' ||
        !uuid(record.assetId) || requested.assetId !== undefined && record.assetId !== requested.assetId || record.url !== `/media/${record.assetId}` ||
        typeof record.requestId !== 'string' || record.requestId.length < 8 || record.requestId.length > 200 ||
        !object(record.snapshot)) return null;
    const assetId = record.assetId;
    const fields = timelineRenderDeliveryFields(record.snapshot);
    if (requireName && typeof fields.deliveryName !== 'string') return null;
    const input = {projectId, requestId: record.requestId, purpose: record.purpose, expectedRevision: record.timelineRevision,
      exportId: record.id, ...fields};
    if (!guards.isTimelineRenderRecord(record, input)) return null;

    const receiptRow: unknown = db.prepare(`SELECT ${bounded('requestId', 800)},${bounded('requestHash', 64)},${bounded('response', RENDER_BYTES)} FROM timeline_requests WHERE requestId=? LIMIT 1`).get(record.requestId);
    if (!object(receiptRow) || receiptRow.requestId !== record.requestId || typeof receiptRow.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receiptRow.requestHash)) return null;
    const receipt = parse(receiptRow.response);
    if (!object(receipt) || !guards.isTimelineRenderRecord(receipt, input) || receipt.status !== 'queued' ||
        receipt.assetId !== null || receipt.url !== null || receipt.error !== null ||
        receipt.createdAt !== record.createdAt || receipt.updatedAt !== receipt.createdAt ||
        ['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision'].some(field => receipt[field] !== record[field]) ||
        JSON.stringify(receipt.snapshot) !== JSON.stringify(record.snapshot)) return null;

    // Independently verifies SQL/JSON ownership and reverse version/image/frame
    // owners. The retained output does not require current editable clips.
    const asset = guards.readOwnedAsset(projectId, assetId);
    if (!object(asset) || asset.id !== assetId || asset.projectId !== projectId ||
        asset.mimeType !== 'video/mp4' || asset.provenance !== 'export' || asset.url !== record.url ||
        !ownsPublishedOutputPath(asset.relativePath, requested.exportId)) return null;
    if (isTimelineExportFloatSnapshot(record.snapshot) && (typeof asset.sha256 !== 'string' ||
        !isTimelineExportAudioOutcome(record, {snapshotSha256: floatSnapshotSha256(record.snapshot), assetSha256: asset.sha256}))) return null;
    // Keep this exact byte calculation for existing named-download fences.
    const identityDigest = createHash('sha256').update(JSON.stringify([row.data, receiptRow.requestHash, receiptRow.response, asset])).digest('hex');
    return Object.freeze({exportId: requested.exportId, assetId, projectId,
      relativePath: asset.relativePath, record, asset, snapshot: record.snapshot, identityDigest});
  } catch {
    return null;
  } finally {
    if (!outer && db.isOpen && db.isTransaction) db.exec('COMMIT');
  }
}

/** Analysis can read named or unnamed historical outputs, scoped by project. */
export function readTimelineExportOutput(
  db: DatabaseSync,
  requested: {projectId: string; exportId: string},
  guards: TimelineDeliveryReadGuards,
): TimelineExportOutput | null {
  if (!uuid(requested.projectId) || !uuid(requested.exportId)) return null;
  return readTimelineExportOutputCore(db, requested, guards, false);
}

/** Historical named downloads retain their filename requirement. */
export function readTimelineDeliveryDownload(
  db: DatabaseSync,
  url: URL,
  guards: TimelineDeliveryReadGuards,
): TimelineDeliveryDownload | null {
  const requested = timelineDeliveryDownloadIdentity(url);
  if (!requested) return null;
  const output = readTimelineExportOutputCore(db, requested, guards, true);
  if (!output) return null;
  const fields = timelineRenderDeliveryFields(output.snapshot);
  if (typeof fields.deliveryName !== 'string') return null;
  const contentDisposition = timelineDeliveryContentDisposition(fields.deliveryName, requested.exportId) +
    `; mioon-export-id="${requested.exportId}"; mioon-asset-id="${requested.assetId}"`;
  return Object.freeze({exportId: requested.exportId, assetId: requested.assetId, projectId: output.projectId,
    relativePath: output.relativePath, mimeType: 'video/mp4', contentDisposition, identityDigest: output.identityDigest});
}

/** Revalidate after pathname/open/stat awaits, immediately before response
 * headers. The existing file responder owns fd cleanup if this opaque gate
 * fails; a replaced owner never receives stale delivery metadata. */
export function timelineDeliveryResponseHeaders(
  db: DatabaseSync,
  url: URL,
  guards: TimelineDeliveryReadGuards,
  expected: TimelineDeliveryDownload,
): Readonly<Record<string, string>> {
  const current = readTimelineDeliveryDownload(db, url, guards);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
    throw Object.assign(new Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
  }
  return {'Content-Type': current.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': current.contentDisposition};
}


/** Dedicated inline playback syntax. Never broadens historical download URLs. */
export function timelineExportPreviewIdentity(url: URL): {assetId: string; exportId: string} | null {
  const assetId = url.pathname.slice('/media/'.length), exportId = url.searchParams.get('exportId');
  const keys = [...url.searchParams.keys()];
  if (url.hash || url.username || url.password || !url.pathname.startsWith('/media/') || !uuid(assetId) || !uuid(exportId) ||
      keys.length !== 2 || keys.filter(key => key === 'preview').length !== 1 || keys.filter(key => key === 'exportId').length !== 1 ||
      url.searchParams.get('preview') !== '1') return null;
  return {assetId, exportId};
}

export type TimelineExportPreviewMedia = Pick<TimelineExportOutput, 'exportId' | 'assetId' | 'projectId' | 'relativePath' | 'identityDigest'> & {readonly mimeType: 'video/mp4'};

/** Both named and unnamed exports require the same exact receipt/output proof. */
export function readTimelineExportPreviewMedia(db: DatabaseSync, url: URL, guards: TimelineDeliveryReadGuards): TimelineExportPreviewMedia | null {
  const requested = timelineExportPreviewIdentity(url);
  if (!requested) return null;
  const output = readTimelineExportOutputCore(db, requested, guards, false);
  if (!output) return null;
  return Object.freeze({exportId: output.exportId, assetId: output.assetId, projectId: output.projectId,
    relativePath: output.relativePath, mimeType: 'video/mp4' as const, identityDigest: output.identityDigest});
}

/** Check the retained owner again after open/stat and before any output bytes. */
export function timelineExportPreviewResponseHeaders(db: DatabaseSync, url: URL, guards: TimelineDeliveryReadGuards,
  expected: TimelineExportPreviewMedia): Readonly<Record<string, string>> {
  const current = readTimelineExportPreviewMedia(db, url, guards);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw Object.assign(new Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
  return {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline'};
}
