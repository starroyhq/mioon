import { clipDraftKeySchema, clipDraftSourceSchema } from './local-drafts.ts';
import { LUT_RESOURCE_LIMITS, lutImportInputSchema } from './lut-resources.ts';
import type { LutImportInput } from './lut-resources.ts';

/** Client-owned receipt hint only: no Cube bytes, paths, credentials or clip
 * settings. The backend's immutable request receipt remains authoritative. */
export const CLIP_LUT_RECOVERY_MAX_BYTES = 2048;
const hash = clipDraftSourceSchema.shape.assetSha256, id = clipDraftKeySchema.shape.projectId;
export interface ClipLutRecoveryMetadata {
  version: 1; workspaceScope: string; projectId: string; requestId: string; name: string; sizeBytes: number; sha256: string;
}
export function parseClipLutRecoveryMetadata(value: unknown): ClipLutRecoveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw corrupt();
  const keys = ['version', 'workspaceScope', 'projectId', 'requestId', 'name', 'sizeBytes', 'sha256'];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !Object.hasOwn(d, 'value'); })) throw corrupt();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !hash.safeParse(v.workspaceScope).success || !id.safeParse(v.projectId).success || !id.safeParse(v.requestId).success ||
      !lutImportInputSchema.shape.name.safeParse(v.name).success || typeof v.name !== 'string' || /[\/\\\u0000-\u001f\u007f]/u.test(v.name) || !/\.cube$/iu.test(v.name) ||
      typeof v.sizeBytes !== 'number' || !Number.isSafeInteger(v.sizeBytes) || v.sizeBytes < 1 || v.sizeBytes > LUT_RESOURCE_LIMITS.sourceBytes || !hash.safeParse(v.sha256).success) throw corrupt();
  if (new TextEncoder().encode(canonicalClipLutRecovery(value as ClipLutRecoveryMetadata)).length > CLIP_LUT_RECOVERY_MAX_BYTES) throw corrupt();
  return value as ClipLutRecoveryMetadata;
}
export interface ClipLutRecoveryIdentity { workspaceScope: string; projectId: string }
export interface ClipLutRecovery {
  read(identity: ClipLutRecoveryIdentity): Promise<ClipLutRecoveryMetadata | null>;
  reserve(value: ClipLutRecoveryMetadata): Promise<void>;
  verify(value: ClipLutRecoveryMetadata): Promise<void>;
  complete(value: ClipLutRecoveryMetadata): Promise<void>;
}
export type ClipLutRecoveryLock = <T>(name: string, action: () => Promise<T>) => Promise<T>;
export type ClipLutRecoveryErrorCode = 'LUT_RECOVERY_UNAVAILABLE' | 'LUT_RECOVERY_CONFLICT' | 'LUT_RECOVERY_CORRUPT';
/** Application-owned error identity. Never infer control flow from translated or
 * third-party diagnostic text. The original message remains diagnostic evidence. */
export class ClipLutRecoveryError extends Error {
  readonly code: ClipLutRecoveryErrorCode;
  constructor(code: ClipLutRecoveryErrorCode, diagnostic: string) {
    super(diagnostic); this.name = 'ClipLutRecoveryError'; this.code = code;
  }
}
export const unavailable = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_UNAVAILABLE', '无法安全读写LUT 恢复记录，已阻止导入。请检查本地存储后重新检查；不要清除待确认记录。');
export const conflict = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_CONFLICT', 'LUT 恢复记录已变化或存在另一条待确认请求。请重新检查并恢复原请求，不会覆盖记录。');
export const corrupt = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_CORRUPT', 'LUT 恢复记录损坏、重复或超出限制，已停止导入且保留原记录；请勿清除记录后重复导入。');
export function clipLutRecoveryKey(identity: ClipLutRecoveryIdentity): string {
  if (!hash.safeParse(identity.workspaceScope).success || !id.safeParse(identity.projectId).success) throw unavailable();
  return `mioon.lut-import.pending.v1:${identity.workspaceScope}:${identity.projectId}`;
}
export const canonicalClipLutRecovery = (value: ClipLutRecoveryMetadata): string => JSON.stringify({ version: value.version, workspaceScope: value.workspaceScope,
  projectId: value.projectId, requestId: value.requestId, name: value.name, sizeBytes: value.sizeBytes, sha256: value.sha256 });
export function clipLutRecoveryMetadata(identity: ClipLutRecoveryIdentity, record: { input: LutImportInput; sizeBytes: number; sha256: string }): ClipLutRecoveryMetadata {
  if (record.input.projectId !== identity.projectId) throw conflict();
  return parseClipLutRecoveryMetadata({ version: 1, workspaceScope: identity.workspaceScope, projectId: identity.projectId, requestId: record.input.requestId,
    name: record.input.name, sizeBytes: record.sizeBytes, sha256: record.sha256 });
}
export function sameClipLutRecovery(left: ClipLutRecoveryMetadata, right: ClipLutRecoveryMetadata): boolean { return canonicalClipLutRecovery(left) === canonicalClipLutRecovery(right); }
export function decodeClipLutRecovery(raw: string | null, identity: ClipLutRecoveryIdentity): ClipLutRecoveryMetadata | null {
  if (raw === null) return null;
  if (raw.length > CLIP_LUT_RECOVERY_MAX_BYTES || new TextEncoder().encode(raw).length > CLIP_LUT_RECOVERY_MAX_BYTES) throw corrupt();
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw corrupt(); }
  const result = parseClipLutRecoveryMetadata(parsed);
  // Canonical equality also rejects duplicate JSON keys, unknown keys and
  // alternate encodings instead of silently normalizing corrupt evidence.
  if (canonicalClipLutRecovery(result) !== raw || result.workspaceScope !== identity.workspaceScope || result.projectId !== identity.projectId) throw corrupt();
  return result;
}

/** Fixed metadata-only desktop IPC. No arbitrary channels, file paths or bytes. */
export const CLIP_LUT_RECOVERY_CHANNEL = 'mioon:lut-recovery:v1';
export type ClipLutRecoveryRequest = { action: 'read'; identity: ClipLutRecoveryIdentity }
  | { action: 'reserve' | 'verify' | 'complete'; value: ClipLutRecoveryMetadata };
export type ClipLutRecoveryResponse = { ok: true; value: ClipLutRecoveryMetadata | null }
  | { ok: false; code: ClipLutRecoveryErrorCode };
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}
export function parseClipLutRecoveryIdentity(value: unknown): ClipLutRecoveryIdentity {
  if (!exactRecord(value, ['workspaceScope', 'projectId']) || !hash.safeParse(value.workspaceScope).success || !id.safeParse(value.projectId).success) throw unavailable();
  return { workspaceScope: value.workspaceScope as string, projectId: value.projectId as string };
}
export function parseClipLutRecoveryRequest(value: unknown): ClipLutRecoveryRequest {
  if (exactRecord(value, ['action', 'identity']) && value.action === 'read') return { action: 'read', identity: parseClipLutRecoveryIdentity(value.identity) };
  if (exactRecord(value, ['action', 'value']) && (value.action === 'reserve' || value.action === 'verify' || value.action === 'complete')) {
    return { action: value.action, value: { ...parseClipLutRecoveryMetadata(value.value) } };
  }
  throw unavailable();
}
export function parseClipLutRecoveryResponse(value: unknown, request: ClipLutRecoveryRequest): ClipLutRecoveryResponse {
  if (exactRecord(value, ['ok', 'code']) && value.ok === false && ['LUT_RECOVERY_UNAVAILABLE', 'LUT_RECOVERY_CONFLICT', 'LUT_RECOVERY_CORRUPT'].includes(value.code as string)) {
    return { ok: false, code: value.code as ClipLutRecoveryErrorCode };
  }
  if (!exactRecord(value, ['ok', 'value']) || value.ok !== true) throw unavailable();
  if (value.value === null) return { ok: true, value: null };
  if (request.action !== 'read') throw unavailable();
  const metadata = parseClipLutRecoveryMetadata(value.value);
  if (metadata.workspaceScope !== request.identity.workspaceScope || metadata.projectId !== request.identity.projectId) throw unavailable();
  return { ok: true, value: { ...metadata } };
}

export interface DesktopLutRecoveryBridge {
  read(identity: ClipLutRecoveryIdentity): Promise<ClipLutRecoveryResponse>;
  reserve(value: ClipLutRecoveryMetadata): Promise<ClipLutRecoveryResponse>;
  verify(value: ClipLutRecoveryMetadata): Promise<ClipLutRecoveryResponse>;
  complete(value: ClipLutRecoveryMetadata): Promise<ClipLutRecoveryResponse>;
}
