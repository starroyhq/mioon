import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {AppError} from '../../../contracts/src/app-error.ts';
import {canonicalJson, PROJECT_SNAPSHOT_PROFILE, snapshotInvalid, validateProjectDocument} from './document.ts';
import type {ProjectDocument} from './document.ts';
import {PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES} from './limits.ts';
export {PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES} from './limits.ts';

// A legal project can retain 64 MiB of LUT bytes. The explicit base64 BLOB
// representation needs ~85.4 MiB before the row/profile envelope and content.
export interface EncodedProjectDocument {
  readonly hash: string;
  readonly rawBytes: number;
  readonly compressedBytes: number;
  readonly payload: Uint8Array;
  readonly profile: 1;
  readonly codec: 'gzip';
}
const limit = (): AppError => new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', '项目内容超过版本快照容量上限，未保存版本。', 413);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function encodeProjectDocument(document: ProjectDocument): EncodedProjectDocument {
  validateProjectDocument(document);
  const text = canonicalJson(document), rawBytes = Buffer.byteLength(text);
  if (rawBytes > PROJECT_SNAPSHOT_MAX_RAW_BYTES) throw limit();
  const raw = Buffer.from(text), payload = gzipSync(raw, {level: 1});
  if (payload.byteLength > PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES) throw limit();
  return {hash: digest(raw), rawBytes, compressedBytes: payload.byteLength, payload, profile: PROJECT_SNAPSHOT_PROFILE, codec: 'gzip'};
}

export function decodeProjectDocument(input: EncodedProjectDocument): ProjectDocument {
  if (!input || input.profile !== PROJECT_SNAPSHOT_PROFILE || input.codec !== 'gzip' || typeof input.hash !== 'string' || !/^[0-9a-f]{64}$/u.test(input.hash)
    || !Number.isSafeInteger(input.rawBytes) || input.rawBytes < 1 || !Number.isSafeInteger(input.compressedBytes) || input.compressedBytes < 1
    || !(input.payload instanceof Uint8Array) || input.payload.byteLength !== input.compressedBytes) throw snapshotInvalid('blob-metadata');
  if (input.rawBytes > PROJECT_SNAPSHOT_MAX_RAW_BYTES || input.compressedBytes > PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES) throw limit();
  let raw: Buffer;
  try {raw = gunzipSync(input.payload, {maxOutputLength: Math.min(input.rawBytes, PROJECT_SNAPSHOT_MAX_RAW_BYTES)});}
  catch {throw snapshotInvalid('gzip');}
  if (raw.byteLength !== input.rawBytes || digest(raw) !== input.hash) throw snapshotInvalid('blob-digest');
  let document: unknown;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    document = JSON.parse(text);
    if (canonicalJson(document) !== text) throw snapshotInvalid('canonical-json');
  } catch {throw snapshotInvalid('json');}
  return validateProjectDocument(document);
}
