import {NATIVE_ASSET_MEDIA_LIMITS, nativeAssetMediaRequestSchema, nativeRelinkPreviewSchema, nativeRelinkApplyResultSchema} from '../../../packages/contracts/src/asset-media-native.ts';
import type {NativeAssetMediaRequest, NativeRelinkPreview, NativeRelinkApplyResult} from '../../../packages/contracts/src/asset-media-native.ts';
import {ProjectMediaError} from './project-media-client.ts';
import type {ProjectMediaRequestOptions} from './project-media-client.ts';

type Input<Action extends NativeAssetMediaRequest['action']> = Omit<Extract<NativeAssetMediaRequest, {action: Action}>, 'action'>;
export interface ProjectMediaNativeClient {
  choose(input: Input<'choose'>, options?: ProjectMediaRequestOptions): Promise<NativeRelinkPreview | null>;
  apply(input: Input<'apply'>, options?: ProjectMediaRequestOptions): Promise<NativeRelinkApplyResult>;
  discard(input: Input<'discard'>): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: unknown): number => {try {return new TextEncoder().encode(JSON.stringify(value)).byteLength;} catch {return Infinity;}};
const protocol = (): ProjectMediaError => new ProjectMediaError('ASSET_RELINK_PROTOCOL');

/** The preload owns the system chooser, consent and private paths. The web
 * adapter only validates its existing projections; it never imports a file. */
export function readProjectMediaNativeClient(host: unknown = globalThis): ProjectMediaNativeClient | null {
  if (!record(host) || !Object.hasOwn(host, '__mioonAssetMediaNative')) return null;
  const bridge = host.__mioonAssetMediaNative;
  if (!record(bridge) || !['choose', 'apply', 'discard'].every(key => typeof bridge[key] === 'function')) throw protocol();
  const methods = {choose: bridge.choose, apply: bridge.apply, discard: bridge.discard};
  const call = (action: NativeAssetMediaRequest['action'], input: unknown): Promise<unknown> => Promise.resolve(Reflect.apply(methods[action] as (...args: unknown[]) => unknown, bridge, [input]));
  function input(action: 'choose', value: Input<'choose'>): Input<'choose'>;
  function input(action: 'apply', value: Input<'apply'>): Input<'apply'>;
  function input(action: 'discard', value: Input<'discard'>): Input<'discard'>;
  function input(action: NativeAssetMediaRequest['action'], value: unknown): Input<'choose'> | Input<'apply'> | Input<'discard'> {
    if (!record(value) || Object.hasOwn(value, 'action')) throw new ProjectMediaError('VALIDATION_ERROR');
    const parsed = nativeAssetMediaRequestSchema.safeParse({...value, action});
    if (!parsed.success || bytes(parsed.data) > NATIVE_ASSET_MEDIA_LIMITS.requestBytes) throw new ProjectMediaError('VALIDATION_ERROR');
    if (parsed.data.action === 'choose') return {projectId: parsed.data.projectId, assetId: parsed.data.assetId, expectedReferenceRevision: parsed.data.expectedReferenceRevision};
    if (parsed.data.action === 'apply') return {projectId: parsed.data.projectId, previewToken: parsed.data.previewToken, requestId: parsed.data.requestId};
    return {projectId: parsed.data.projectId, previewToken: parsed.data.previewToken};
  }
  const discard = async (value: Input<'discard'>): Promise<void> => {
    const exact = input('discard', value), result = await call('discard', exact);
    if (result !== undefined) throw protocol();
  };
  async function request<T>(operation: () => Promise<T>, options: ProjectMediaRequestOptions, write: boolean): Promise<T> {
    if (!record(options) || Object.keys(options).some(key => key !== 'signal') || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new ProjectMediaError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw new ProjectMediaError('INTERRUPTED');
    let dispatched = false, rejectAbort: (error: ProjectMediaError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (): void => rejectAbort(new ProjectMediaError('INTERRUPTED', {outcomeUnknown: write && dispatched}));
    options.signal?.addEventListener('abort', stop, {once: true});
    try {dispatched = true; return await Promise.race([operation(), stopped]);}
    catch (error) {
      if (error instanceof ProjectMediaError) throw new ProjectMediaError(error.code, {status: error.status, outcomeUnknown: error.outcomeUnknown || write && dispatched && error.status === undefined});
      const value = error as {code?: unknown; status?: unknown} | null;
      const known = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/u.test(value.code) && Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599;
      const unknown = write && dispatched && (!known || Number(value?.status) >= 500 || ['ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', 'PROJECT_ENTRY_OUTCOME_UNKNOWN'].includes(String(value?.code)));
      throw new ProjectMediaError(known ? String(value!.code) : 'ASSET_RELINK_UNAVAILABLE', {status: known ? Number(value!.status) : undefined, outcomeUnknown: unknown});
    } finally {options.signal?.removeEventListener('abort', stop);}
  }
  return Object.freeze({
    async choose(value: Input<'choose'>, options: ProjectMediaRequestOptions = {}) {
      const exact = input('choose', value);
      return request(async () => {
        const raw = await call('choose', exact);
        if (raw === null) return null;
        const parsed = nativeRelinkPreviewSchema.safeParse(raw);
        if (!parsed.success || bytes(raw) > NATIVE_ASSET_MEDIA_LIMITS.responseBytes) throw protocol();
        const preview = parsed.data;
        if (preview.projectId !== exact.projectId || preview.assetId !== exact.assetId || preview.expectedReferenceRevision !== exact.expectedReferenceRevision) throw protocol();
        // IPC does not accept AbortSignal. An ignored-signal late answer owns
        // only an expiring preview; retire it without applying or authorizing.
        if (options.signal?.aborted) {void discard({projectId: exact.projectId, previewToken: preview.previewToken}).catch(() => {}); throw new ProjectMediaError('INTERRUPTED');}
        return preview;
      }, options, false);
    },
    async apply(value: Input<'apply'>, options: ProjectMediaRequestOptions = {}) {
      const exact = input('apply', value);
      return request(async () => {
        const raw = await call('apply', exact), parsed = nativeRelinkApplyResultSchema.safeParse(raw);
        if (!parsed.success || bytes(raw) > NATIVE_ASSET_MEDIA_LIMITS.responseBytes || parsed.data.status === 'applied' && parsed.data.assets.some(asset => asset.projectId !== exact.projectId)) throw protocol();
        return parsed.data;
      }, options, true);
    },
    discard,
  });
}
