import { CLIP_LUT_RECOVERY_MAX_BYTES, ClipLutRecoveryError, unavailable, conflict, corrupt,
  clipLutRecoveryKey, parseClipLutRecoveryMetadata, canonicalClipLutRecovery, decodeClipLutRecovery, sameClipLutRecovery } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import type { ClipLutRecovery, ClipLutRecoveryIdentity, ClipLutRecoveryLock } from '../../../packages/contracts/src/clip-lut-recovery.ts';
export { CLIP_LUT_RECOVERY_MAX_BYTES, ClipLutRecoveryError, clipLutRecoveryKey, clipLutRecoveryMetadata, sameClipLutRecovery } from '../../../packages/contracts/src/clip-lut-recovery.ts';
export type { ClipLutRecovery, ClipLutRecoveryMetadata, ClipLutRecoveryIdentity, ClipLutRecoveryLock, ClipLutRecoveryErrorCode } from '../../../packages/contracts/src/clip-lut-recovery.ts';
export function createBrowserClipLutRecovery({ storage = () => globalThis.localStorage, lock = async (name, action) => {
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
  const read = (identity: ClipLutRecoveryIdentity) => access(identity, (store, key) => decodeClipLutRecovery(store.getItem(key), identity));
  return {
    read,
    async reserve(value) {
      const checked = parseClipLutRecoveryMetadata(value), raw = canonicalClipLutRecovery(checked);
      if (new TextEncoder().encode(raw).length > CLIP_LUT_RECOVERY_MAX_BYTES) throw corrupt();
      await access(value, (store, key) => {
        const existing = decodeClipLutRecovery(store.getItem(key), value);
        if (existing && !sameClipLutRecovery(existing, checked)) throw conflict();
        if (!existing) store.setItem(key, raw);
        if (store.getItem(key) !== raw) throw conflict();
      });
    },
    async verify(value) { const existing = await read(value); if (!existing || !sameClipLutRecovery(existing, value)) throw conflict(); },
    async complete(value) {
      await access(value, (store, key) => {
        const existing = decodeClipLutRecovery(store.getItem(key), value);
        // Another tab may already have cleared this exact successful request.
        if (!existing) return;
        if (!sameClipLutRecovery(existing, value)) throw conflict();
        store.removeItem(key);
        if (store.getItem(key) !== null) throw conflict();
      });
    },
  };
}

import { parseClipLutRecoveryRequest, parseClipLutRecoveryResponse } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import type { DesktopLutRecoveryBridge, ClipLutRecoveryRequest } from '../../../packages/contracts/src/clip-lut-recovery.ts';
type RecoveryEnvironment = { __mioonLutRecovery?: DesktopLutRecoveryBridge; __mioonDesktop?: unknown; __mioonProjectWindow?: unknown; navigator?: { userAgent?: string } };
/** Desktop marker/UA ensures a broken or missing preload never becomes a
 * transient browser store. Explicit test/browser storage injection is separate. */
export function createDesktopOrBrowserLutRecovery(environment: RecoveryEnvironment = globalThis): ClipLutRecovery {
  const desktop = environment.__mioonDesktop === true || environment.__mioonProjectWindow !== undefined ||
    environment.__mioonLutRecovery !== undefined || /\bElectron\//u.test(environment.navigator?.userAgent ?? '');
  if (!desktop) return createBrowserClipLutRecovery();
  async function invoke(input: ClipLutRecoveryRequest) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = parseClipLutRecoveryRequest(input), bridge = environment.__mioonLutRecovery;
      if (!bridge || !['read', 'reserve', 'verify', 'complete'].every(key => typeof bridge[key as keyof DesktopLutRecoveryBridge] === 'function')) throw unavailable();
      const pending = request.action === 'read' ? bridge.read(request.identity) : bridge[request.action](request.value);
      const response = parseClipLutRecoveryResponse(await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), 5000);
      })]), request);
      if (!response.ok) throw new ClipLutRecoveryError(response.code, 'LUT recovery is blocked; retain the original request.');
      return response.value;
    } catch (error) { if (error instanceof ClipLutRecoveryError) throw error; throw unavailable(); }
    finally { if (timer) clearTimeout(timer); }
  }
  return {
    read: identity => invoke({ action: 'read', identity }),
    async reserve(value) { await invoke({ action: 'reserve', value }); },
    async verify(value) { await invoke({ action: 'verify', value }); },
    async complete(value) { await invoke({ action: 'complete', value }); },
  };
}
export function createClipLutRecovery(options?: Parameters<typeof createBrowserClipLutRecovery>[0]): ClipLutRecovery {
  return options === undefined ? createDesktopOrBrowserLutRecovery() : createBrowserClipLutRecovery(options);
}
