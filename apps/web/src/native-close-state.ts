import type { NativeLegacyCloseSnapshot } from './native-close-legacy.ts';
import type { SettingsNavigationCapture, SettingsNavigationRegistry } from './settings-navigation-state.ts';

export interface NativeCloseState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly version: number;
}
type Source = NativeCloseState & { readonly slot: string; readonly owner: number };
type Capture = readonly Source[];
const slots = new Set(['agent-chat', 'agent-edits', 'image-generation']);
const validState = (value: NativeCloseState): boolean => Boolean(value && typeof value.dirty === 'boolean' &&
  typeof value.busy === 'boolean' && typeof value.blocked === 'boolean' && Number.isSafeInteger(value.version) && value.version > 0);

/** Only non-secret status and owner counters enter this registry. */
export function createNativeCloseRegistry() {
  let serial = 0;
  const sources = new Map<string, Source>();
  const captures = new WeakSet<Capture>();
  return {
    register(slot: string) {
      if (!slots.has(slot)) throw new TypeError('Unknown native close source');
      const owner = ++serial;
      sources.set(slot, Object.freeze({ slot, owner, dirty: false, busy: true, blocked: true, version: 0 }));
      return {
        update(state: NativeCloseState) {
          const previous = sources.get(slot);
          if (previous?.owner !== owner) return;
          if (!validState(state)) {
            sources.set(slot, Object.freeze({ ...previous, busy: true, blocked: true }));
            return;
          }
          if (state.version <= previous.version) return;
          sources.set(slot, Object.freeze({ slot, owner, dirty: state.dirty, busy: state.busy, blocked: state.blocked, version: state.version }));
        },
        release() { if (sources.get(slot)?.owner === owner) sources.delete(slot); },
      };
    },
    capture(): Capture {
      const capture = Object.freeze([...sources.values()]);
      captures.add(capture);
      return capture;
    },
    isCurrent(capture: Capture): boolean {
      return captures.has(capture) && capture.length === sources.size && capture.every(source => sources.get(source.slot) === source);
    },
  };
}
export type NativeCloseRegistry = ReturnType<typeof createNativeCloseRegistry>;
type Disposition = 'clean' | 'dirty' | 'blocked' | 'unknown' | 'unknown-dirty';
export type NativeCloseAction = 'close' | 'reload';
/** Pure renderer-local metadata. Identity must include each participating
 * controller owner, version and operation; no business data leaves the page. */
export interface NativeAdditionalCloseSnapshot {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly unknown: boolean;
  readonly identity: readonly unknown[];
}
type Ticket = {
  token: string;
  sources: Capture;
  settings: SettingsNavigationCapture;
  scope: string;
  action: NativeCloseAction;
  documentURL: string;
  targetUrl: string | null;
  interaction: number;
  dirty: boolean;
  legacy: NativeLegacyCloseSnapshot;
  additional: NativeAdditionalCloseSnapshot | null;
  disposition: Disposition;
};
interface CommitOptions { discardDirty: boolean; allowDrainFailure: boolean; allowUnknown?: boolean; expiresAt: number; action?: NativeCloseAction; targetUrl?: string | null }
export interface NativeCloseInspection { version: 1; token: string; disposition: Disposition }
interface UnloadEvent { preventDefault(): void; returnValue: string }
interface LifecycleEvent { readonly type: string }
type ArmedClose = { ticket: Ticket; expiresAt: number; revoked: boolean; discardDirty: boolean; allowUnknown: boolean };

/** A renderer-local, one-use close capability. It cannot write, drain, retry or
 * approve business work. Main receives only an opaque token and disposition. */
export function createNativeCloseAdmission({ registry, settings, readScope, readLegacyDirty = () => false, readLegacySnapshot = () => ({ dirty: readLegacyDirty(), identity: [] }), readDocumentURL = () => '',
  readAdditionalSnapshot = () => ({ dirty: false, busy: false, unknown: false, identity: [] }),
  onObservationPause,
  now = Date.now, newToken = () => globalThis.crypto.randomUUID(), maxLeaseMs = 2000,
}: {
  registry: NativeCloseRegistry;
  settings: Pick<SettingsNavigationRegistry, 'capture' | 'canLeave' | 'needsConfirmation'>;
  readScope: () => string;
  readLegacyDirty?: () => boolean;
  readLegacySnapshot?: () => NativeLegacyCloseSnapshot;
  readDocumentURL?: () => string;
  readAdditionalSnapshot?: () => NativeAdditionalCloseSnapshot;
  onObservationPause?: (paused: boolean) => void;
  now?: () => number;
  newToken?: () => string;
  maxLeaseMs?: number;
}) {
  let active = true, interaction = 0, ticket: Ticket | null = null;
  let armed: ArmedClose | null = null;
  // Final validation cannot resume observation: doing so could initiate reads
  // or change owners during beforeunload. Main's exact cancel releases this
  // separate token even after final validation has consumed the close ticket.
  let observationToken: string | null = null;
  const preparingRiskUnload = new WeakMap<UnloadEvent, ArmedClose>();
  let admittedRiskExit: ArmedClose | null = null;
  const isRiskClose = (permission: ArmedClose) => permission.allowUnknown && permission.ticket.action === 'close' &&
    permission.ticket.additional?.unknown === true;
  const sourceBlocked = (capture: Capture) => capture.some(source => source.busy || source.blocked);
  const readAdditional = (): NativeAdditionalCloseSnapshot | null => {
    try {
      const value = readAdditionalSnapshot();
      if (!value || typeof value.dirty !== 'boolean' || typeof value.busy !== 'boolean' ||
        typeof value.unknown !== 'boolean' || !Array.isArray(value.identity) || value.unknown && value.identity.length === 0) return null;
      // Copy the sequence: mutating a caller-owned identity array must never
      // retroactively update the ticket that the user actually approved.
      return Object.freeze({ dirty: value.dirty, busy: value.busy, unknown: value.unknown, identity: Object.freeze([...value.identity]) });
    } catch { return null; }
  };
  const matchesCapture = (value: Ticket): boolean => {
    const legacy = readLegacySnapshot(), additional = readAdditional();
    return active && value.scope === readScope() && value.documentURL === readDocumentURL() &&
      value.interaction === interaction && registry.isCurrent(value.sources) && settings.canLeave(value.settings) &&
      !sourceBlocked(value.sources) && (!legacy.dirty || value.dirty) &&
      additional !== null && value.additional !== null && !additional.busy &&
      additional.dirty === value.additional.dirty && additional.unknown === value.additional.unknown &&
      additional.identity.length === value.additional.identity.length &&
      additional.identity.every((item, index) => Object.is(item, value.additional!.identity[index])) &&
      legacy.identity.length === value.legacy.identity.length && legacy.identity.every((item, index) => Object.is(item, value.legacy.identity[index]));
  };
  const current = (value: Ticket) => ticket === value && matchesCapture(value);
  const block = (event: UnloadEvent) => { event.preventDefault(); event.returnValue = ''; return false; };
  return {
    inspect(action: NativeCloseAction = 'close', targetUrl: string | null = null): NativeCloseInspection {
      admittedRiskExit = null;
      const token = newToken();
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(token)) throw new TypeError('Invalid close token');
      if (armed) armed.revoked = true;
      let observationReady = active;
      if (active) {
        observationToken = token;
        try { onObservationPause?.(true); } catch { observationReady = false; }
      }
      try {
      const documentURL = readDocumentURL();
      const validAction = action === 'close' ? targetUrl === null : action === 'reload' &&
        typeof targetUrl === 'string' && targetUrl.length > 0 && targetUrl.length <= 8192 && targetUrl === documentURL;
      const sources = registry.capture(), configuration = settings.capture(), legacy = readLegacySnapshot(), additional = readAdditional();
      const dirty = Boolean(legacy.dirty) || Boolean(additional?.dirty) || sources.some(source => source.dirty) || settings.needsConfirmation(configuration);
      const disposition: Disposition = !validAction || !active || !observationReady || sourceBlocked(sources) || !settings.canLeave(configuration) ||
        additional === null || additional.busy || additional.unknown && action !== 'close' ? 'blocked' :
        additional.unknown ? dirty ? 'unknown-dirty' : 'unknown' : dirty ? 'dirty' : 'clean';
      ticket = { token, sources, settings: configuration, scope: readScope(), action, documentURL, targetUrl, interaction, dirty, legacy, additional, disposition };
      return Object.freeze({ version: 1, token, disposition });
      } catch {
        // Preserve the opaque cancellation handle even if a pure owner reader
        // fails, so main can resume this exact observation without guessing.
        ticket = null;
        return Object.freeze({ version: 1, token, disposition: 'blocked' });
      }
    },
    commit(token: string, options: CommitOptions): boolean {
      const captured = ticket;
      if (!captured || token !== captured.token || captured.disposition === 'blocked' || !options ||
        typeof options.discardDirty !== 'boolean' || typeof options.allowDrainFailure !== 'boolean' ||
        options.allowUnknown !== undefined && typeof options.allowUnknown !== 'boolean' ||
        (captured.additional?.unknown ? captured.action !== 'close' || options.allowUnknown !== true || options.allowDrainFailure : options.allowUnknown === true) ||
        (options.action === undefined ? 'close' : options.action) !== captured.action ||
        (options.targetUrl === undefined ? null : options.targetUrl) !== captured.targetUrl ||
        !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now() || options.expiresAt - now() > maxLeaseMs ||
        !current(captured) || captured.dirty && !options.discardDirty) return false;
      armed = { ticket: captured, expiresAt: options.expiresAt, revoked: false, discardDirty: options.discardDirty, allowUnknown: options.allowUnknown === true };
      return true;
    },
    cancel(token: string): boolean {
      const exited = admittedRiskExit?.ticket.token === token;
      if (exited) admittedRiskExit = null;
      const observed = observationToken === token;
      const captured = ticket?.token === token;
      if (captured) {
        if (armed?.ticket === ticket) armed.revoked = true;
        ticket = null;
      }
      if (observed) {
        observationToken = null;
        try { onObservationPause?.(false); } catch { /* Close authority remains cancelled. */ }
      }
      return exited || observed || captured;
    },
    interacted() { interaction++; admittedRiskExit = null; },
    /** Capture phase only binds this event to an already-armed risk attempt.
     * It grants no unload permission and does not read/sync/write a controller.
     * Even a stale risk attempt must reach the final veto without first causing
     * App's earlier-registered lifecycle listener to issue another write. */
    prepareBeforeUnload(event: UnloadEvent) {
      if (armed && !armed.revoked && isRiskClose(armed)) preparingRiskUnload.set(event, armed);
    },
    /** Read-only, narrowly scoped suppression of automatic lifecycle writes.
     * Hidden/pagehide/cleanup cannot create or consume native close authority.
     * Explicit saves and the ordinary native drain do not consult this method. */
    suppressLifecycleFlush(event?: LifecycleEvent): boolean {
      if (event?.type === 'beforeunload') return preparingRiskUnload.has(event as LifecycleEvent & UnloadEvent);
      if (event && event.type !== 'pagehide' && event.type !== 'visibilitychange') return false;
      const permission = admittedRiskExit;
      if (!permission || permission.revoked || permission.expiresAt <= now()) return false;
      try { return matchesCapture(permission.ticket); } catch { return false; }
    },
    beforeUnload(event: UnloadEvent): boolean {
      admittedRiskExit = null;
      try {
      const prepared = preparingRiskUnload.get(event);
      preparingRiskUnload.delete(event);
      const permission = armed;
      if (prepared && prepared !== permission) return block(event);
      if (permission) {
        armed = null;
        const allowed = !permission.revoked && permission.expiresAt > now() && current(permission.ticket) &&
          (!permission.ticket.additional?.unknown || permission.ticket.action === 'close' && permission.allowUnknown) &&
          (!permission.ticket.dirty || permission.discardDirty);
        ticket = null;
        if (allowed && isRiskClose(permission)) admittedRiskExit = permission;
        return allowed ? true : block(event);
      }
      const sources = registry.capture(), configuration = settings.capture(), additional = readAdditional();
      if (!active || sourceBlocked(sources) || !settings.canLeave(configuration) || readLegacySnapshot().dirty ||
        additional === null || additional.dirty || additional.busy || additional.unknown ||
        sources.some(source => source.dirty) || settings.needsConfirmation(configuration)) return block(event);
      return true;
      } catch { armed = null; ticket = null; return block(event); }
    },
    dispose() { active = false; if (armed) armed.revoked = true; admittedRiskExit = null; observationToken = null; ticket = null; },
  };
}
export type NativeCloseAdmission = ReturnType<typeof createNativeCloseAdmission>;

type Page = Pick<Window, 'addEventListener' | 'removeEventListener'> & { __mioonNativeCloseAdmission?: NativeCloseAdmission };
/** Installs only fixed lifecycle operations. DOM interactions carry no field
 * values and invalidate any native confirmation before it can discard input. */
export function installNativeCloseAdmission(page: Page, options: Parameters<typeof createNativeCloseAdmission>[0]): () => void {
  const admission = createNativeCloseAdmission(options);
  const interaction = () => admission.interacted();
  const prepare = (event: BeforeUnloadEvent) => admission.prepareBeforeUnload(event);
  const warn = (event: BeforeUnloadEvent) => { admission.beforeUnload(event); };
  page.__mioonNativeCloseAdmission = admission;
  for (const name of ['input', 'change', 'click', 'keydown']) page.addEventListener(name, interaction, true);
  // The capture binding runs before App's earlier bubble-phase flush listener;
  // final validation remains in its original later listener, after any late ACK.
  page.addEventListener('beforeunload', prepare, true);
  page.addEventListener('beforeunload', warn);
  page.addEventListener('pageshow', interaction);
  return () => {
    admission.dispose();
    for (const name of ['input', 'change', 'click', 'keydown']) page.removeEventListener(name, interaction, true);
    page.removeEventListener('beforeunload', prepare, true);
    page.removeEventListener('beforeunload', warn);
    page.removeEventListener('pageshow', interaction);
    if (page.__mioonNativeCloseAdmission === admission) delete page.__mioonNativeCloseAdmission;
  };
}
