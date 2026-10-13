import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {isTimelineExportFloatSnapshot, isTimelineExportAudioOutcome, timelineExportAudioCheckSchema,
  TIMELINE_EXPORT_FLOAT_PROFILE_ID, TIMELINE_EXPORT_FLOAT_POLICY_ID} from '@mioon/contracts/timeline-export-float';
import type {TimelineExportAudioCheck, TimelineExportAudioMeasurement, TimelineExportAudioOutput} from '@mioon/contracts/timeline-export-float';
import {timelineRenderDeliveryFields} from '@mioon/contracts/timeline-delivery';
import {timelineExportOutputFrames} from '@mioon/contracts/timeline-export-range';
import {isOwnedTimelineFloatAudioMeasurement, readTimelineFloatAudioCheckFailure} from './timeline-float-audio-check.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const MAX_ROW_BYTES = 4 * 1024 * 1024;
function invalid(): never {
  throw Object.assign(new Error('The frozen float export or its current attempt cannot be verified.'), {code: 'INVALID_TIMELINE_SNAPSHOT', status: 409});
}
export function isFloatTimelineExport(value: unknown): value is Row & {snapshot: Row} {
  return object(value) && value.mode === 'timeline' && value.purpose === 'export' &&
    object(value.snapshot) && isTimelineExportFloatSnapshot(value.snapshot);
}
/** Server-only attempt identities never enter the immutable acceptance ACK. */
export function claimFloatTimelineExport(value: unknown, updatedAt: string): Row {
  if (!isFloatTimelineExport(value) || value.status !== 'queued' ||
      Object.hasOwn(value, 'renderAttemptId') || Object.hasOwn(value, 'audioCheck')) invalid();
  return {...value, status: 'running', renderAttemptId: randomUUID(), updatedAt};
}
export function sameFloatTimelineAttempt(expected: unknown, current: unknown): boolean {
  if (!isFloatTimelineExport(expected)) return true;
  if (!isFloatTimelineExport(current)) return false;
  return !Object.hasOwn(expected, 'renderAttemptId') ||
    uuid(expected.renderAttemptId) && current.renderAttemptId === expected.renderAttemptId;
}
export function createFloatTimelineAttemptRegistry(): {
  remember(signal: AbortSignal, value: unknown): void;
  read(signal: AbortSignal): Row | undefined;
} {
  const claims = new WeakMap<AbortSignal, Row>();
  return Object.freeze({remember(signal: AbortSignal, value: unknown): void {
    if (isFloatTimelineExport(value) && uuid(value.renderAttemptId)) claims.set(signal, value);
  }, read: (signal: AbortSignal): Row | undefined => claims.get(signal)});
}
/** Legitimate interruption loses only this attempt's observation, never the
 * frozen snapshot/request identity. This does not itself authorize requeue. */
export function requeueFloatTimelineExport(value: unknown): Row {
  if (!isFloatTimelineExport(value)) invalid();
  const {renderAttemptId: _attempt, audioCheck: _report, ...row} = value;
  return row;
}
export function floatSnapshotSha256(snapshot: unknown): string {
  // Match the existing preflight/admission canonical snapshot digest, including
  // backend-only relative paths; no caller-supplied public digest is authority.
  const raw = JSON.stringify(snapshot, (_key: string, item: unknown): unknown => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_ROW_BYTES) invalid();
  return createHash('sha256').update(raw).digest('hex');
}
function identity(value: unknown, checkedAt: string) {
  if (!isFloatTimelineExport(value) || !uuid(value.id) || !uuid(value.projectId) || !uuid(value.renderAttemptId)) invalid();
  return {schemaVersion: 1 as const, profileId: TIMELINE_EXPORT_FLOAT_PROFILE_ID,
    policyId: TIMELINE_EXPORT_FLOAT_POLICY_ID, stage: 'preencode_float_mix' as const,
    projectId: value.projectId, exportId: value.id, attemptId: value.renderAttemptId,
    snapshotSha256: floatSnapshotSha256(value.snapshot), outputFrames: timelineExportOutputFrames(value.snapshot), checkedAt};
}
/** A result object from an injected renderer is insufficient: only a measurement
 * produced by the bounded media checker in this lifetime is accepted. */
export function bindFloatTimelineMeasurement(value: unknown, measurement: unknown, checkedAt: string,
  output: TimelineExportAudioOutput | null = null): TimelineExportAudioCheck {
  if (!isOwnedTimelineFloatAudioMeasurement(measurement)) invalid();
  return timelineExportAudioCheckSchema.parse({...identity(value, checkedAt), status: 'complete',
    code: measurement.peakLinear > 1 ? 'EXPORT_AUDIO_OVER_RANGE' : 'EXPORT_AUDIO_WITHIN_LIMIT', measurement, output});
}
export function ownedFloatTimelineMeasurement(result: unknown): TimelineExportAudioMeasurement {
  if (!object(result) || !isOwnedTimelineFloatAudioMeasurement(result.audioCheck)) invalid();
  return result.audioCheck;
}
/** Errors cannot self-assert an observation. Cancellation/unknown child exit
 * follows the worker's separate requeue/pause path and does not call this. */
export function bindFloatTimelineFailure(value: unknown, error: unknown, checkedAt: string): TimelineExportAudioCheck | undefined {
  const observed = readTimelineFloatAudioCheckFailure(error);
  if (!observed) return undefined;
  if (observed.measurement !== null) return bindFloatTimelineMeasurement(value, observed.measurement, checkedAt);
  return timelineExportAudioCheckSchema.parse({...identity(value, checkedAt), status: 'incomplete',
    code: observed.code, measurement: null, output: null});
}

export interface FloatExportReadGuards {
  rowIdentity?: Readonly<{id: string; projectId?: string}>;
  isTimelineRenderRecord(value: unknown, input: Readonly<Row>): boolean;
  readOwnedAsset(projectId: string, assetId: string): unknown;
}
const parse = (value: unknown): unknown => {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};
const retainedIdentity = (value: Row): string => JSON.stringify(Object.fromEntries(
  ['id','projectId','requestId','mode','purpose','timelineRevision','snapshot','createdAt'].map(key => [key, value[key]])));

/** Conditional, bounded v2 guard for current records. Legacy returns the exact
 * supplied object without normalization. Receipt-side detection stops stripping
 * v2 metadata from disguising an accepted v2 job as a historical legacy export. */
export function assertFloatTimelineExportRead(db: DatabaseSync, value: unknown, guards: FloatExportReadGuards): void {
  if (guards.rowIdentity && (!object(value) || value.id !== guards.rowIdentity.id ||
      guards.rowIdentity.projectId !== undefined && value.projectId !== guards.rowIdentity.projectId)) invalid();
  if (!object(value)) return;
  const ownProfile = object(value.snapshot) && object(value.snapshot.delivery) &&
    (object(value.snapshot.delivery.exportSettings) && value.snapshot.delivery.exportSettings.profileId === TIMELINE_EXPORT_FLOAT_PROFILE_ID ||
     object(value.snapshot.delivery.effective) && value.snapshot.delivery.effective.profileId === TIMELINE_EXPORT_FLOAT_PROFILE_ID);
  const outcomeFields = Object.hasOwn(value, 'renderAttemptId') || Object.hasOwn(value, 'audioCheck');
  if ((ownProfile || outcomeFields) && (!uuid(value.id) || !uuid(value.projectId))) invalid();
  if (!uuid(value.id) || !uuid(value.projectId)) return;
  // Storyboard export.create has a separate idempotency namespace. Its own
  // positive receipt and relational/JSON owner proof can exclude an unrelated
  // same-key timeline receipt. Mismatching IDs alone are never a bypass for a
  // stripped or corrupted v2 row. Only bounded discriminators cross this read.
  const receiptProfile: unknown = db.prepare(`SELECT CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${MAX_ROW_BYTES}
    THEN CASE WHEN json_valid(response) THEN json_extract(response,'$.snapshot.delivery.exportSettings.profileId')=? END END AS isFloat,
    CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${MAX_ROW_BYTES}
    THEN CASE WHEN json_valid(response) THEN json_extract(response,'$.id')=? END END AS sameExport
    FROM timeline_requests WHERE requestId=? LIMIT 1`).get(TIMELINE_EXPORT_FLOAT_PROFILE_ID, value.id as string, typeof value.requestId === 'string' ? value.requestId : '');
  if (!ownProfile && !outcomeFields) {
    if (!object(receiptProfile) || receiptProfile.isFloat !== 1) return;
    if (receiptProfile.sameExport === 0 && typeof value.requestId === 'string' &&
        !Object.hasOwn(value, 'mode') && Array.isArray(value.snapshot)) {
      // Require the exact persisted JSON value (ignoring whitespace), without
      // materializing another legacy payload or imposing a new legacy size cap.
      // The legacy export.create canonical input has exactly these two sorted
      // scalar keys. Do not change its existing scope or stored receipt bytes.
      const legacyHash = createHash('sha256').update(JSON.stringify({projectId: value.projectId, requestId: value.requestId})).digest('hex');
      const legacyOwner = db.prepare(`SELECT 1 AS owned FROM idempotency i JOIN exports e ON e.id=i.resourceId
        WHERE i.scope='export' AND i.requestId=? AND i.requestHash=? AND i.resourceId=? AND e.projectId=?
        AND CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.id')=e.id
          AND json_extract(e.data,'$.projectId')=e.projectId AND json_extract(e.data,'$.requestId')=i.requestId
          AND json_type(e.data,'$.mode') IS NULL AND json_type(e.data,'$.snapshot')='array'
          AND json(e.data)=json(?) END LIMIT 1`)
        .get(value.requestId, legacyHash, value.id as string, value.projectId as string, JSON.stringify(value));
      if (legacyOwner) return;
    }
  }
  if (!isFloatTimelineExport(value) || typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 200) invalid();
  const row: unknown = db.prepare(`SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${MAX_ROW_BYTES} THEN data END AS data
    FROM exports WHERE id=? AND projectId=? LIMIT 1`).get(value.id as string, value.projectId as string);
  if (!object(row) || row.id !== value.id || row.projectId !== value.projectId ||
      typeof row.data !== 'string' || JSON.stringify(parse(row.data)) !== JSON.stringify(value)) invalid();
  const receiptRow: unknown = db.prepare(`SELECT CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${MAX_ROW_BYTES} THEN response END AS response,
    CASE WHEN typeof(requestHash)='text' AND length(CAST(requestHash AS BLOB))=64 THEN requestHash END AS requestHash
    FROM timeline_requests WHERE requestId=? LIMIT 1`).get(value.requestId as string);
  const receipt = object(receiptRow) ? parse(receiptRow.response) : null;
  const input = {projectId: value.projectId, requestId: value.requestId, purpose: value.purpose,
    expectedRevision: value.timelineRevision, ...timelineRenderDeliveryFields(value.snapshot)};
  if (!object(receiptRow) || !digest(receiptRow.requestHash) || !object(receipt) || receipt.status !== 'queued' || !guards.isTimelineRenderRecord(receipt, input) ||
      !guards.isTimelineRenderRecord(value, input) || retainedIdentity(receipt) !== retainedIdentity(value)) invalid();
  let assetSha256: string | undefined;
  if (value.status === 'succeeded') {
    if (!uuid(value.assetId)) invalid();
    const asset = guards.readOwnedAsset(value.projectId as string, value.assetId);
    if (!object(asset) || asset.id !== value.assetId || asset.projectId !== value.projectId ||
        asset.provenance !== 'export' || asset.mimeType !== 'video/mp4' || !digest(asset.sha256)) invalid();
    assetSha256 = asset.sha256;
  }
  if (!isTimelineExportAudioOutcome(value, {snapshotSha256: floatSnapshotSha256(value.snapshot),
    ...(assetSha256 === undefined ? {} : {assetSha256})})) invalid();
}
