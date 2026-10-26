import {isMenuCommandIntent} from './menu-command-protocol.ts';
import type {MenuCommandIntent} from './menu-command-protocol.ts';

/** The host executes this fixed import entry with userGesture=true on the
 * captured frame. Never accept renderer code, selectors, paths or transport. */
export function menuCommandGestureScript(value: unknown): string {
  if (!isMenuCommandIntent(value) || value.command !== 'import-media') throw new Error('Invalid native import gesture.');
  const intent: MenuCommandIntent = {version: 1, windowId: value.windowId, backendId: value.backendId, contextId: value.contextId,
    role: value.role, command: value.command, sequence: value.sequence, reportVersion: value.reportVersion};
  // Recheck the scalar snapshot too: even a local object with changing getters
  // cannot expand the fixed, bounded schema between validation and encoding.
  if (!isMenuCommandIntent(intent) || intent.command !== 'import-media') throw new Error('Invalid native import gesture.');
  return `globalThis.__mioonMenuCommands?.receiveUserGesture?.(${JSON.stringify(intent)}) === true`;
}
