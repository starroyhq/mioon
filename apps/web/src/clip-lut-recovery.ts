import { clipDraftKeySchema, clipDraftSourceSchema } from '../../../packages/contracts/src/local-drafts.ts';
import { LUT_RESOURCE_LIMITS, lutImportInputSchema } from '../../../packages/contracts/src/lut-resources.ts';
import type { LutImportInput } from '../../../packages/contracts/src/lut-resources.ts';

/** Browser-owned receipt hint only: no Cube bytes, paths, credentials or clip
 * settings. The backend's immutable request receipt remains authoritative. */
export const CLIP_LUT_RECOVERY_MAX_BYTES = 2048;
const hash = clipDraftSourceSchema.shape.assetSha256, id = clipDraftKeySchema.shape.projectId;
export interface ClipLutRecoveryMetadata {
  version: 1; workspaceScope: string; projectId: string; requestId: string; name: string; sizeBytes: number; sha256: string;
}
function parseMetadata(value: unknown): ClipLutRecoveryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const keys = ['version', 'workspaceScope', 'projectId', 'requestId', 'name', 'sizeBytes', 'sha256'];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !Object.hasOwn(d, 'value'); })) throw corrupt();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !hash.safeParse(v.workspaceScope).success || !id.safeParse(v.projectId).success || !id.safeParse(v.requestId).success ||
      !lutImportInputSchema.shape.name.safeParse(v.name).success || typeof v.name !== 'string' || !/\.cube$/iu.test(v.name) ||
      typeof v.sizeBytes !== 'number' || !Number.isSafeInteger(v.sizeBytes) || v.sizeBytes < 1 || v.sizeBytes > LUT_RESOURCE_LIMITS.sourceBytes || !hash.safeParse(v.sha256).success) throw corrupt();
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
const unavailable = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_UNAVAILABLE', '无法安全读写浏览器的 LUT 恢复记录，已阻止导入。请允许此站点的本地存储后重新检查；不要清除待确认记录。');
const conflict = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_CONFLICT', 'LUT 恢复记录已变化或存在另一条待确认请求。请重新检查并恢复原请求，不会覆盖记录。');
const corrupt = (): ClipLutRecoveryError => new ClipLutRecoveryError('LUT_RECOVERY_CORRUPT', 'LUT 恢复记录损坏、重复或超出限制，已停止导入且保留原记录；请勿清除记录后重复导入。');
export function clipLutRecoveryKey(identity: ClipLutRecoveryIdentity): string {
  if (!hash.safeParse(identity.workspaceScope).success || !id.safeParse(identity.projectId).success) throw unavailable();
  return `mioon.lut-import.pending.v1:${identity.workspaceScope}:${identity.projectId}`;
}
const canonical = (value: ClipLutRecoveryMetadata): string => JSON.stringify({ version: value.version, workspaceScope: value.workspaceScope,
  projectId: value.projectId, requestId: value.requestId, name: value.name, sizeBytes: value.sizeBytes, sha256: value.sha256 });
export function clipLutRecoveryMetadata(identity: ClipLutRecoveryIdentity, record: { input: LutImportInput; sizeBytes: number; sha256: string }): ClipLutRecoveryMetadata {
  if (record.input.projectId !== identity.projectId) throw conflict();
  return parseMetadata({ version: 1, workspaceScope: identity.workspaceScope, projectId: identity.projectId, requestId: record.input.requestId,
    name: record.input.name, sizeBytes: record.sizeBytes, sha256: record.sha256 });
}
export function sameClipLutRecovery(left: ClipLutRecoveryMetadata, right: ClipLutRecoveryMetadata): boolean { return canonical(left) === canonical(right); }
function decode(raw: string | null, identity: ClipLutRecoveryIdentity): ClipLutRecoveryMetadata | null {
  if (raw === null) return null;
  if (raw.length > CLIP_LUT_RECOVERY_MAX_BYTES || new TextEncoder().encode(raw).length > CLIP_LUT_RECOVERY_MAX_BYTES) throw corrupt();
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw corrupt(); }
  const result = parseMetadata(parsed);
  // Canonical equality also rejects duplicate JSON keys, unknown keys and
  // alternate encodings instead of silently normalizing corrupt evidence.
  if (canonical(result) !== raw || result.workspaceScope !== identity.workspaceScope || result.projectId !== identity.projectId) throw corrupt();
  return result;
}
export function createClipLutRecovery({ storage = () => globalThis.localStorage, lock = async (name, action) => {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw unavailable();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
  try { return await navigator.locks.request(name, { mode: 'exclusive', signal: controller.signal }, action); }
  finally { clearTimeout(timeout); }
} }: { storage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; lock?: ClipLutRecoveryLock } = {}): ClipLutRecovery {
  async function access<T>(identity: ClipLutRecoveryIdentity, action: (store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string) => T): Promise<T> {
    const key = clipLutRecoveryKey(identity);
    try { return await lock(key, async () => action(storage(), key)); }
    catch (error) { if (error instanceof ClipLutRecoveryError) throw error; throw unavailable(); }
  }
  const read = (identity: ClipLutRecoveryIdentity) => access(identity, (store, key) => decode(store.getItem(key), identity));
  return {
    read,
    async reserve(value) {
      const checked = parseMetadata(value), raw = canonical(checked);
      if (new TextEncoder().encode(raw).length > CLIP_LUT_RECOVERY_MAX_BYTES) throw corrupt();
      await access(value, (store, key) => {
        const existing = decode(store.getItem(key), value);
        if (existing && !sameClipLutRecovery(existing, checked)) throw conflict();
        if (!existing) store.setItem(key, raw);
        if (store.getItem(key) !== raw) throw conflict();
      });
    },
    async verify(value) { const existing = await read(value); if (!existing || !sameClipLutRecovery(existing, value)) throw conflict(); },
    async complete(value) {
      await access(value, (store, key) => {
        const existing = decode(store.getItem(key), value);
        // Another tab may already have cleared this exact successful request.
        if (!existing) return;
        if (!sameClipLutRecovery(existing, value)) throw conflict();
        store.removeItem(key);
        if (store.getItem(key) !== null) throw conflict();
      });
    },
  };
}
