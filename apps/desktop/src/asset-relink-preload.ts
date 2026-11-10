import {
  NATIVE_ASSET_MEDIA_CHANNEL, NATIVE_ASSET_MEDIA_LIMITS, nativeAssetMediaRequestSchema,
  nativeRelinkPreviewSchema, nativeRelinkApplyResultSchema,
} from '../../../packages/contracts/src/asset-media-native.ts';
import type {NativeAssetMediaRequest, NativeRelinkPreview, NativeRelinkApplyResult} from '../../../packages/contracts/src/asset-media-native.ts';

export interface NativeAssetMediaBridge {
  choose(input: Omit<Extract<NativeAssetMediaRequest, {action: 'choose'}>, 'action'>): Promise<NativeRelinkPreview | null>;
  apply(input: Omit<Extract<NativeAssetMediaRequest, {action: 'apply'}>, 'action'>): Promise<NativeRelinkApplyResult>;
  discard(input: Omit<Extract<NativeAssetMediaRequest, {action: 'discard'}>, 'action'>): Promise<void>;
}
const invalid = () => new Error('Invalid native asset media response.');
const bytes = (value: unknown): number => {try {return new TextEncoder().encode(JSON.stringify(value)).byteLength;} catch {return Infinity;}};
export function createNativeAssetMediaBridge(invoke: (channel: typeof NATIVE_ASSET_MEDIA_CHANNEL, input: unknown) => Promise<unknown>): NativeAssetMediaBridge {
  const request = async (input: NativeAssetMediaRequest): Promise<unknown> => {
    const checked = nativeAssetMediaRequestSchema.parse(input);
    if (bytes(checked) > NATIVE_ASSET_MEDIA_LIMITS.requestBytes) throw invalid();
    const value = await invoke(NATIVE_ASSET_MEDIA_CHANNEL, checked);
    if (bytes(value) > NATIVE_ASSET_MEDIA_LIMITS.responseBytes || value === null || typeof value !== 'object' || Array.isArray(value) || !('ok' in value)) throw invalid();
    if (value.ok === true) {
      if (Object.keys(value).sort().join(',') !== 'data,ok' || !('data' in value)) throw invalid();
      return value.data;
    }
    if (value.ok !== false || Object.keys(value).sort().join(',') !== 'error,ok' || !('error' in value)) throw invalid();
    const error = value.error as {code?: unknown; status?: unknown} | null;
    if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).sort().join(',') !== 'code,status' ||
        typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,99}$/u.test(error.code) || !Number.isInteger(error.status) || Number(error.status) < 400 || Number(error.status) > 599) throw invalid();
    // Keep the rejection cloneable across contextBridge; the page owns Error
    // construction and its existing known/unknown outcome classification.
    throw {code: error.code, status: error.status};
  };
  return Object.freeze({
    choose: async (input: Parameters<NativeAssetMediaBridge['choose']>[0]) => {
      const value = await request({...input, action: 'choose'});
      if (value === null) return null;
      const preview = nativeRelinkPreviewSchema.parse(value);
      if (preview.projectId !== input.projectId || preview.assetId !== input.assetId || preview.expectedReferenceRevision !== input.expectedReferenceRevision) throw invalid();
      return preview;
    },
    apply: async (input: Parameters<NativeAssetMediaBridge['apply']>[0]) => {
      const result = nativeRelinkApplyResultSchema.parse(await request({...input, action: 'apply'}));
      if (result.status === 'applied' && result.assets.some(asset => asset.projectId !== input.projectId)) throw invalid();
      return result;
    },
    discard: async (input: Parameters<NativeAssetMediaBridge['discard']>[0]) => {if (await request({...input, action: 'discard'}) !== true) throw invalid();},
  });
}
