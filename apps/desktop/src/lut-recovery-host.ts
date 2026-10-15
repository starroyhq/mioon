import { ClipLutRecoveryError, parseClipLutRecoveryRequest, parseClipLutRecoveryMetadata, unavailable } from '../../../packages/contracts/src/clip-lut-recovery.ts';
import type { ClipLutRecoveryIdentity, ClipLutRecoveryMetadata, ClipLutRecoveryResponse } from '../../../packages/contracts/src/clip-lut-recovery.ts';
interface Owner { readonly projectId: string; isCurrent(): boolean }
interface Store {
  read(identity: ClipLutRecoveryIdentity): ClipLutRecoveryMetadata | null;
  reserve(value: ClipLutRecoveryMetadata): void;
  verify(value: ClipLutRecoveryMetadata): void;
  complete(value: ClipLutRecoveryMetadata): void;
}
interface Options<Event> {
  /** Captures the exact current owned editor main-frame document, or null. */
  ownerForEvent(event: Event): Owner | null;
  /** Derives scope from trusted build channel/config/filesystem, never IPC. */
  currentWorkspaceScope(): string;
  createStore(guard: () => void): Store;
}
/** One queue for every editor in this app. Capture before queueing and fence
 * again after waiting, before publication and before releasing any metadata. */
export function createDesktopLutRecoveryHost<Event>(options: Options<Event>) {
  let tail: Promise<void> = Promise.resolve(), active: (() => void) | null = null;
  const store = options.createStore(() => { if (!active) throw unavailable(); active(); });
  function dispatch(event: Event, input: unknown): Promise<ClipLutRecoveryResponse> {
    let request: ReturnType<typeof parseClipLutRecoveryRequest>, owner: Owner, scope: string;
    try {
      request = parseClipLutRecoveryRequest(input);
      const captured = options.ownerForEvent(event);
      if (!captured || !captured.isCurrent()) throw unavailable();
      owner = captured; scope = options.currentWorkspaceScope();
      const identity = request.action === 'read' ? request.identity : request.value;
      if (identity.projectId !== owner.projectId || identity.workspaceScope !== scope) throw unavailable();
    } catch { return Promise.resolve({ ok: false, code: 'LUT_RECOVERY_UNAVAILABLE' }); }
    const run = tail.then((): ClipLutRecoveryResponse => {
      try {
        const identity = request.action === 'read' ? request.identity : request.value;
        active = () => {
          if (!owner.isCurrent() || identity.projectId !== owner.projectId || options.currentWorkspaceScope() !== scope || identity.workspaceScope !== scope) throw unavailable();
        };
        active();
        let result: ClipLutRecoveryMetadata | null = null;
        if (request.action === 'read') {
          const value = store.read(request.identity);
          if (value !== null) {
            result = { ...parseClipLutRecoveryMetadata(value) };
            if (result.workspaceScope !== scope || result.projectId !== owner.projectId) throw unavailable();
          }
        } else store[request.action](request.value);
        active();
        return { ok: true, value: result };
      } catch (error) { return { ok: false, code: error instanceof ClipLutRecoveryError ? error.code : 'LUT_RECOVERY_UNAVAILABLE' }; }
      finally { active = null; }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  return Object.freeze({ dispatch });
}
