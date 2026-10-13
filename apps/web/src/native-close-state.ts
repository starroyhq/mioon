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
type Disposition = 'clean' | 'dirty' | 'blocked';
export type NativeCloseAction = 'close' | 'reload';
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
  disposition: Disposition;
};
interface CommitOptions { discardDirty: boolean; allowDrainFailure: boolean; expiresAt: number; action?: NativeCloseAction; targetUrl?: string | null }
export interface NativeCloseInspection { version: 1; token: string; disposition: Disposition }
interface UnloadEvent { preventDefault(): void; returnValue: string }

/** A renderer-local, one-use close capability. It cannot write, drain, retry or
 * approve business work. Main receives only an opaque token and disposition. */
export function createNativeCloseAdmission({ registry, settings, readScope, readLegacyDirty = () => false, readLegacySnapshot = () => ({ dirty: readLegacyDirty(), identity: [] }), readDocumentURL = () => '',
  now = Date.now, newToken = () => globalThis.crypto.randomUUID(), maxLeaseMs = 2000,
}: {
  registry: NativeCloseRegistry;
  settings: Pick<SettingsNavigationRegistry, 'capture' | 'canLeave' | 'needsConfirmation'>;
  readScope: () => string;
  readLegacyDirty?: () => boolean;
  readLegacySnapshot?: () => NativeLegacyCloseSnapshot;
  readDocumentURL?: () => string;
  now?: () => number;
  newToken?: () => string;
  maxLeaseMs?: number;
}) {
  let active = true, interaction = 0, ticket: Ticket | null = null;
  let armed: { ticket: Ticket; expiresAt: number; revoked: boolean; discardDirty: boolean } | null = null;
  const sourceBlocked = (capture: Capture) => capture.some(source => source.busy || source.blocked);
  const current = (value: Ticket): boolean => {
    const legacy = readLegacySnapshot();
    return active && ticket === value && value.scope === readScope() && value.documentURL === readDocumentURL() &&
      value.interaction === interaction && registry.isCurrent(value.sources) && settings.canLeave(value.settings) &&
      !sourceBlocked(value.sources) && (!legacy.dirty || value.dirty) &&
      legacy.identity.length === value.legacy.identity.length && legacy.identity.every((item, index) => Object.is(item, value.legacy.identity[index]));
  };
  const block = (event: UnloadEvent) => { event.preventDefault(); event.returnValue = ''; return false; };
  return {
    inspect(action: NativeCloseAction = 'close', targetUrl: string | null = null): NativeCloseInspection {
      const documentURL = readDocumentURL();
      const validAction = action === 'close' ? targetUrl === null : action === 'reload' &&
        typeof targetUrl === 'string' && targetUrl.length > 0 && targetUrl.length <= 8192 && targetUrl === documentURL;
      const sources = registry.capture(), configuration = settings.capture(), legacy = readLegacySnapshot();
      const dirty = Boolean(legacy.dirty) || sources.some(source => source.dirty) || settings.needsConfirmation(configuration);
      const disposition: Disposition = !validAction || !active || sourceBlocked(sources) || !settings.canLeave(configuration) ? 'blocked' : dirty ? 'dirty' : 'clean';
      const token = newToken();
      if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(token)) throw new TypeError('Invalid close token');
      if (armed) armed.revoked = true;
      ticket = { token, sources, settings: configuration, scope: readScope(), action, documentURL, targetUrl, interaction, dirty, legacy, disposition };
      return Object.freeze({ version: 1, token, disposition });
    },
    commit(token: string, options: CommitOptions): boolean {
      const captured = ticket;
      if (!captured || token !== captured.token || captured.disposition === 'blocked' || !options ||
        typeof options.discardDirty !== 'boolean' || typeof options.allowDrainFailure !== 'boolean' ||
        (options.action === undefined ? 'close' : options.action) !== captured.action ||
        (options.targetUrl === undefined ? null : options.targetUrl) !== captured.targetUrl ||
        !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now() || options.expiresAt - now() > maxLeaseMs ||
        !current(captured) || captured.dirty && !options.discardDirty) return false;
      armed = { ticket: captured, expiresAt: options.expiresAt, revoked: false, discardDirty: options.discardDirty };
      return true;
    },
    cancel(token: string): boolean {
      if (!ticket || ticket.token !== token) return false;
      if (armed?.ticket === ticket) armed.revoked = true;
      ticket = null;
      return true;
    },
    interacted() { interaction++; },
    beforeUnload(event: UnloadEvent): boolean {
      try {
      const permission = armed;
      if (permission) {
        armed = null;
        const allowed = !permission.revoked && permission.expiresAt > now() && current(permission.ticket) &&
          (!permission.ticket.dirty || permission.discardDirty);
        ticket = null;
        return allowed ? true : block(event);
      }
      const sources = registry.capture(), configuration = settings.capture();
      if (!active || sourceBlocked(sources) || !settings.canLeave(configuration) || readLegacySnapshot().dirty ||
        sources.some(source => source.dirty) || settings.needsConfirmation(configuration)) return block(event);
      return true;
      } catch { armed = null; ticket = null; return block(event); }
    },
    dispose() { active = false; if (armed) armed.revoked = true; ticket = null; },
  };
}
export type NativeCloseAdmission = ReturnType<typeof createNativeCloseAdmission>;

type Page = Pick<Window, 'addEventListener' | 'removeEventListener'> & { __mioonNativeCloseAdmission?: NativeCloseAdmission };
/** Installs only fixed lifecycle operations. DOM interactions carry no field
 * values and invalidate any native confirmation before it can discard input. */
export function installNativeCloseAdmission(page: Page, options: Parameters<typeof createNativeCloseAdmission>[0]): () => void {
  const admission = createNativeCloseAdmission(options);
  const interaction = () => admission.interacted();
  const warn = (event: BeforeUnloadEvent) => { admission.beforeUnload(event); };
  page.__mioonNativeCloseAdmission = admission;
  for (const name of ['input', 'change', 'click', 'keydown']) page.addEventListener(name, interaction, true);
  page.addEventListener('beforeunload', warn);
  return () => {
    admission.dispose();
    for (const name of ['input', 'change', 'click', 'keydown']) page.removeEventListener(name, interaction, true);
    page.removeEventListener('beforeunload', warn);
    if (page.__mioonNativeCloseAdmission === admission) delete page.__mioonNativeCloseAdmission;
  };
}
