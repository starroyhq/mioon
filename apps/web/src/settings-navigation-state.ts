/** Read-only navigation metadata. Neither a draft nor a credential belongs here. */
export interface SettingsNavigationState {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly version: number;
}

interface SettingsNavigationInput {
  dirty: boolean;
  phase: string;
  recovery?: unknown;
}
type SettingsNavigationCallback = (state: SettingsNavigationState) => void;
const knownPhases = new Set(['loading', 'ready', 'saving', 'saved', 'reconciling', 'checking', 'review', 'blocked', 'error', 'load_error']);

export function settingsNavigationState(input: SettingsNavigationInput, version: number): SettingsNavigationState {
  return Object.freeze({
    dirty: Boolean(input.dirty),
    busy: ['loading', 'saving', 'reconciling', 'checking'].includes(input.phase),
    // A matching readback is still unresolved until the existing session's
    // explicit review action clears recovery. Unknown phases fail closed.
    blocked: Boolean(input.recovery) || ['review', 'blocked'].includes(input.phase) || !knownPhases.has(input.phase),
    version,
  });
}

/** Publish at the input/session boundary, before a React render can be deferred.
 * Every event gets a new version, including a second nonempty password edit.
 * Consumers must bind their own owner and compare versions after confirmation;
 * these reports never grant permission to discard, save, retry or navigate. */
export function createSettingsNavigationReporter() {
  let version = 0;
  let owner: object | null = null;
  let callback: SettingsNavigationCallback | undefined;
  let current = settingsNavigationState({ dirty: false, phase: 'loading' }, version);
  const publish = (input: SettingsNavigationInput) => {
    current = settingsNavigationState(input, ++version);
    callback?.(current);
    return current;
  };
  return {
    connect(onChange: SettingsNavigationCallback | undefined, input: SettingsNavigationInput) {
      owner = {};
      callback = onChange;
      const mountedOwner = owner;
      publish(input);
      return mountedOwner;
    },
    update(input: SettingsNavigationInput) {
      return owner ? publish(input) : current;
    },
    disconnect(mountedOwner: object) {
      if (owner !== mountedOwner) return;
      // A replaced callback's cleanup cannot reset the newer registration.
      const notify = callback;
      owner = null;
      callback = undefined;
      current = settingsNavigationState({ dirty: false, phase: 'ready' }, ++version);
      notify?.(current);
    },
    getState: () => current,
  };
}

export interface SettingsNavigationCaptureEntry extends SettingsNavigationState {
  readonly slot: string;
  readonly owner: number;
}
export type SettingsNavigationCapture = readonly SettingsNavigationCaptureEntry[];

/** Only mounted settings owners may report into a slot. This registry holds
 * booleans and counters, never settings fields or any discard/save action. */
export function createSettingsNavigationRegistry() {
  let serial = 0;
  const slots = new Map<string, { owner: number; state: SettingsNavigationState }>();
  const captures = new WeakSet<SettingsNavigationCapture>();
  function register(slot: string) {
    const owner = ++serial;
    // Registration cannot make an unreported form appear safe to leave.
    slots.set(slot, { owner, state: Object.freeze({ dirty: false, busy: true, blocked: true, version: 0 }) });
    return {
      update(state: SettingsNavigationState) {
        const mounted = slots.get(slot);
        if (mounted?.owner !== owner || !Number.isSafeInteger(state.version) || state.version <= mounted.state.version) return;
        mounted.state = Object.freeze({ dirty: Boolean(state.dirty), busy: Boolean(state.busy), blocked: Boolean(state.blocked), version: state.version });
      },
      release() { if (slots.get(slot)?.owner === owner) slots.delete(slot); },
    };
  }
  function capture(): SettingsNavigationCapture {
    const snapshot = Object.freeze(Array.from(slots, ([slot, { owner, state }]) => Object.freeze({ slot, owner, ...state })));
    captures.add(snapshot);
    return snapshot;
  }
  function canLeave(snapshot: SettingsNavigationCapture): boolean {
    return captures.has(snapshot) && snapshot.length === slots.size && snapshot.every(before => {
      const current = slots.get(before.slot);
      return current?.owner === before.owner && current.state.version === before.version && !current.state.busy && !current.state.blocked;
    });
  }
  function needsConfirmation(snapshot: SettingsNavigationCapture): boolean {
    return !captures.has(snapshot) || snapshot.some(state => state.dirty);
  }
  return { register, capture, canLeave, needsConfirmation };
}
export type SettingsNavigationRegistry = ReturnType<typeof createSettingsNavigationRegistry>;

/** Preserve the legacy synchronous close when no departure guard is supplied.
 * Cancellation never mutates the form; permission is useful only while the
 * exact interaction captured by the caller is still current. */
export function closeSettingsAfterPermission(
  beforeClose: (() => unknown) | undefined,
  isCurrent: () => boolean,
  close: () => void,
): boolean | Promise<boolean> {
  if (!isCurrent()) return false;
  if (!beforeClose) { close(); return true; }
  let permission: unknown;
  try { permission = beforeClose(); }
  catch { return Promise.resolve(false); }
  return Promise.resolve(permission).then(accepted => {
    if (accepted !== true || !isCurrent()) return false;
    close();
    return true;
  }, () => false);
}
