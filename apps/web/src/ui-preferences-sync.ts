export const UI_PREFERENCES_SYNC_CHANNEL = 'mioon:ui-preferences:v1';
const messageType = 'ui-preferences-saved';

interface SyncWindow {
  readonly BroadcastChannel?: new (name: string) => BroadcastChannel;
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
}
interface SyncOptions {
  readonly revision: () => number | null;
  readonly canRefresh: () => boolean;
  readonly refresh: () => void;
}

export function uiPreferencesRevisionHint(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).sort().join(',') !== 'revision,type,version'
    || message.type !== messageType || message.version !== 1
    || typeof message.revision !== 'number' || !Number.isSafeInteger(message.revision) || message.revision < 0) return null;
  return message.revision;
}

/** A channel message is only a reread hint, never a preference snapshot. A
 * deferred hint is consumed once; failed reads can recover on the next focus. */
export function createUiPreferencesSync(target: SyncWindow, options: SyncOptions) {
  let active = true, pendingRevision: number | null = null, seenRevision = -1, focusRequested = false;
  let channel: BroadcastChannel | null = null;
  const drain = () => {
    if (!active || !options.canRefresh()) return;
    const newer = pendingRevision !== null && pendingRevision > (options.revision() ?? -1);
    pendingRevision = null;
    if (!newer && !focusRequested) return;
    focusRequested = false;
    options.refresh();
  };
  const hint = (revision: number) => {
    if (!active) return;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision <= (options.revision() ?? -1) || revision <= seenRevision) return;
    seenRevision = revision; pendingRevision = revision; drain();
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (!active) return;
    const revision = uiPreferencesRevisionHint(event.data);
    if (revision !== null) hint(revision);
  };
  const focus = () => { if (active) { focusRequested = true; drain(); } };
  // Restricted browser contexts may disable BroadcastChannel. A focus reread
  // remains available without changing the accepted save's outcome.
  try {
    if (target.BroadcastChannel) {
      channel = new target.BroadcastChannel(UI_PREFERENCES_SYNC_CHANNEL);
      channel.addEventListener('message', receive);
    }
  } catch { channel?.close(); channel = null; }
  target.addEventListener('focus', focus);
  return {
    drain,
    hint,
    announce(revision: number) {
      if (!active || !channel || !Number.isSafeInteger(revision) || revision < 0) return;
      try { channel.postMessage({ type: messageType, version: 1, revision }); }
      catch { /* The saved revision remains authoritative; focus can resync. */ }
    },
    close() {
      active = false;
      target.removeEventListener('focus', focus);
      channel?.removeEventListener('message', receive);
      channel?.close();
      channel = null;
    },
  };
}
