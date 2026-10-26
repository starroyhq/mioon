import {MENU_COMMAND_CHANNEL, MENU_COMMAND_EVENT, freezeMenuCommandState, isMenuCommandIntent, isMenuCommandState,
  isMenuDocumentIdentity, sameMenuDocument} from './menu-command-protocol.ts';
import type {MenuCommandGestureBridge, MenuCommandIntent, MenuCommandRequest, MenuDocumentIdentity} from './menu-command-protocol.ts';
interface Transport {
  invoke(channel: typeof MENU_COMMAND_CHANNEL, request: MenuCommandRequest): Promise<unknown>;
  on(channel: typeof MENU_COMMAND_EVENT, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof MENU_COMMAND_EVENT, listener: (event: unknown, value: unknown) => void): void;
}
const rejected = () => new Error('Native menu commands are unavailable.');

/** Exactly one consumer, bound for this preload's lifetime. Electron event
 * objects and arbitrary transport never escape into the renderer. */
export function createMenuCommandBridge(transport: Transport): MenuCommandGestureBridge {
  let identity: MenuDocumentIdentity | null = null, sequence = 0;
  let releaseCurrent: (() => void) | null = null;
  let deliverCurrent: ((value: unknown) => boolean) | null = null;
  async function context(): Promise<MenuDocumentIdentity> {
    const value = await transport.invoke(MENU_COMMAND_CHANNEL, {action: 'describe'});
    if (!isMenuDocumentIdentity(value) || identity && !sameMenuDocument(identity, value)) throw rejected();
    identity ??= Object.freeze({...value});
    return identity;
  }
  return Object.freeze({context,
    async publish(state) {
      if (!isMenuCommandState(state)) throw rejected();
      const snapshot = freezeMenuCommandState(state), owner = await context();
      const value = await transport.invoke(MENU_COMMAND_CHANNEL, {action: 'publish', contextId: owner.contextId, state: snapshot});
      if (typeof value !== 'boolean') throw rejected();
      return value;
    },
    receiveUserGesture(value) {
      let snapshot: MenuCommandIntent;
      try {
        if (!isMenuCommandIntent(value)) return false;
        const copied = {...value};
        if (!isMenuCommandIntent(copied) || copied.command !== 'import-media') return false;
        snapshot = Object.freeze(copied);
      } catch { return false; }
      return deliverCurrent?.(snapshot) ?? false;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw rejected();
      releaseCurrent?.();
      let active = true;
      const deliver = (value: unknown): boolean => {
        if (!active || !identity || !isMenuCommandIntent(value) || !sameMenuDocument(identity, value) || value.sequence <= sequence) return false;
        sequence = value.sequence;
        listener(Object.freeze({...value}) as MenuCommandIntent);
        return true;
      };
      const receive = (_event: unknown, value: unknown) => { deliver(value); };
      transport.on(MENU_COMMAND_EVENT, receive);
      deliverCurrent = deliver;
      const release = () => {
        if (!active) return;
        active = false; transport.removeListener(MENU_COMMAND_EVENT, receive);
        if (releaseCurrent === release) releaseCurrent = null;
        if (deliverCurrent === deliver) deliverCurrent = null;
      };
      releaseCurrent = release;
      return release;
    },
  } satisfies MenuCommandGestureBridge);
}
